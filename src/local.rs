//! The local socket the relay serves and its helpers connect to: a Unix domain socket. Windows has them too
//! (`AF_UNIX` in winsock), but neither std nor tokio offers them there, so its half is winsock calls whose streams pass
//! as TCP ones.

pub use imp::{BlockingStream, Listener, Stream, connect, connect_blocking, peer_pid, usable};

#[cfg(unix)]
mod imp {
    use std::io;
    use std::path::Path;

    pub use std::os::unix::net::UnixStream as BlockingStream;
    pub use tokio::net::UnixStream as Stream;

    pub struct Listener(tokio::net::UnixListener);

    impl Listener {
        /// Inside the tokio runtime.
        pub fn bind(path: &Path) -> io::Result<Self> {
            tokio::net::UnixListener::bind(path).map(Self)
        }

        /// A listener the service manager passed. Inside the tokio runtime.
        pub fn from_std(listener: std::os::unix::net::UnixListener) -> io::Result<Self> {
            listener.set_nonblocking(true)?;
            tokio::net::UnixListener::from_std(listener).map(Self)
        }

        pub async fn accept(&mut self) -> io::Result<Stream> {
            self.0.accept().await.map(|(stream, _)| stream)
        }
    }

    pub async fn connect(path: &Path) -> io::Result<Stream> {
        Stream::connect(path).await
    }

    pub fn connect_blocking(path: &Path) -> io::Result<BlockingStream> {
        BlockingStream::connect(path)
    }

    pub fn peer_pid(stream: &Stream) -> Option<i32> {
        stream.peer_cred().ok()?.pid()
    }

    /// Fails for a path no socket can bind: too long, or holding a NUL.
    pub fn usable(path: &Path) -> io::Result<()> {
        std::os::unix::net::SocketAddr::from_pathname(path).map(|_| ())
    }
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::io::{AsRawSocket, FromRawSocket as _, OwnedSocket, RawSocket};
    use std::path::Path;
    use std::sync::OnceLock;
    use std::time::Duration;

    use tokio::sync::mpsc;
    use windows_sys::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
    use windows_sys::Win32::Networking::WinSock::{
        AF_UNIX, FIONBIO, INVALID_SOCKET, POLLRDNORM, SIO_AF_UNIX_GETPEERPID, SOCK_STREAM, SOCKADDR, SOCKADDR_UN, SOCKET,
        WSA_FLAG_NO_HANDLE_INHERIT, WSA_FLAG_OVERLAPPED, WSADATA, WSAEWOULDBLOCK, WSAPOLLFD, WSAPoll, WSAIoctl, WSASocketW, WSAStartup,
        accept, bind, connect as wsa_connect, ioctlsocket, listen,
    };

    pub use std::net::TcpStream as BlockingStream;
    pub use tokio::net::TcpStream as Stream;

    /// How long the accept thread waits before it looks again whether the listener was dropped.
    const STOP_CHECK: Duration = Duration::from_millis(200);
    const BACKLOG: i32 = 64;

    /// Winsock wants `WSAStartup` before any other call; std makes it only once it opens a socket of its own.
    fn started() -> io::Result<()> {
        static STARTED: OnceLock<i32> = OnceLock::new();
        let error = *STARTED.get_or_init(|| {
            // SAFETY: WSADATA is plain integers and byte arrays, so zeroed is valid; WSAStartup fills it in.
            let mut data: WSADATA = unsafe { std::mem::zeroed() };
            // SAFETY: `data` is a writable WSADATA.
            unsafe { WSAStartup(0x0202, &raw mut data) }
        });
        if error == 0 { Ok(()) } else { Err(io::Error::from_raw_os_error(error)) }
    }

    fn address(path: &Path) -> io::Result<SOCKADDR_UN> {
        let invalid = |why: &str| io::Error::new(io::ErrorKind::InvalidInput, format!("socket path {} {why}", path.display()));
        let bytes = path.to_str().ok_or_else(|| invalid("isn't UTF-8"))?.as_bytes();
        // SAFETY: SOCKADDR_UN is an integer and a byte array, so zeroed is valid: an empty, NUL-terminated path.
        let mut address: SOCKADDR_UN = unsafe { std::mem::zeroed() };
        if bytes.len() >= address.sun_path.len() {
            return Err(invalid("is too long for a socket"));
        }
        address.sun_family = AF_UNIX;
        for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
            *slot = i8::from_ne_bytes([*byte]);
        }
        Ok(address)
    }

    /// Fails for a path no socket can bind: too long, or not UTF-8.
    pub fn usable(path: &Path) -> io::Result<()> {
        address(path).map(|_| ())
    }

    /// Calls `bind` or `connect` with `address`.
    fn with_address(socket: &OwnedSocket, address: &SOCKADDR_UN, call: unsafe extern "system" fn(SOCKET, *const SOCKADDR, i32) -> i32) -> io::Result<()> {
        let size = i32::try_from(size_of::<SOCKADDR_UN>()).map_err(io::Error::other)?;
        // SAFETY: the socket is open, and `address` is a SOCKADDR_UN of `size` bytes.
        let failed = unsafe { call(raw(socket), (&raw const *address).cast::<SOCKADDR>(), size) };
        if failed == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }

    /// Not inheritable, unlike what `socket` makes: a command mask-run starts would hold its relay stream open past
    /// mask-run itself, as std's sockets don't.
    fn new_socket() -> io::Result<OwnedSocket> {
        started()?;
        // SAFETY: no protocol info; the result is checked before use.
        let raw = unsafe { WSASocketW(i32::from(AF_UNIX), SOCK_STREAM, 0, std::ptr::null(), 0, WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT) };
        if raw == INVALID_SOCKET {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `raw` is a socket just opened, owned by nothing else.
        Ok(unsafe { OwnedSocket::from_raw_socket(raw as u64) })
    }

    const _: () = assert!(size_of::<SOCKET>() == size_of::<RawSocket>());

    #[allow(clippy::cast_possible_truncation, reason = "the same width, asserted above")]
    fn raw(socket: &impl AsRawSocket) -> SOCKET {
        socket.as_raw_socket() as SOCKET
    }

    fn set_nonblocking(socket: &OwnedSocket) -> io::Result<()> {
        let mut on = 1u32;
        // SAFETY: FIONBIO reads one u32 from `on`.
        let failed = unsafe { ioctlsocket(raw(socket), FIONBIO, &raw mut on) };
        if failed == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }

    /// Accepts on its own thread, which owns the listening socket and closes it once the listener is dropped, so its
    /// handle can't be reused under a pending `accept`.
    pub struct Listener(mpsc::UnboundedReceiver<BlockingStream>);

    impl Listener {
        pub fn bind(path: &Path) -> io::Result<Self> {
            let listening = new_socket()?;
            with_address(&listening, &address(path)?, bind)?;
            // SAFETY: the socket is open and bound.
            if unsafe { listen(raw(&listening), BACKLOG) } != 0 {
                return Err(io::Error::last_os_error());
            }
            set_nonblocking(&listening)?;
            let (tx, rx) = mpsc::unbounded_channel();
            std::thread::Builder::new().name("accept".to_owned()).spawn(move || serve(&listening, &tx))?;
            Ok(Self(rx))
        }

        /// Inside the tokio runtime. A connection that can't be taken into the runtime is dropped and the next one
        /// waited for: the callers stop serving at an error.
        pub async fn accept(&mut self) -> io::Result<Stream> {
            loop {
                let accepted = self.0.recv().await.ok_or_else(|| io::Error::other("the accept thread ended"))?;
                if let Ok(stream) = accepted.set_nonblocking(true).and_then(|()| Stream::from_std(accepted)) {
                    return Ok(stream);
                }
            }
        }
    }

    /// A failed poll or accept is one client's (gone before it was accepted) or passing (out of handles), as tokio's
    /// accept errors are on Unix: the listener goes on after a pause.
    fn serve(listening: &OwnedSocket, tx: &mpsc::UnboundedSender<BlockingStream>) {
        let timeout = i32::try_from(STOP_CHECK.as_millis()).unwrap_or(i32::MAX);
        while !tx.is_closed() {
            let mut poll = WSAPOLLFD { fd: raw(listening), events: POLLRDNORM, revents: 0 };
            // SAFETY: `poll` is one WSAPOLLFD on the open listening socket.
            let ready = unsafe { WSAPoll(&raw mut poll, 1, timeout) };
            if ready < 0 {
                std::thread::sleep(STOP_CHECK);
                continue;
            }
            if ready == 0 {
                continue;
            }
            // SAFETY: the socket is open and listening; null address pointers ask for no peer address.
            let accepted = unsafe { accept(raw(listening), std::ptr::null_mut(), std::ptr::null_mut()) };
            if accepted == INVALID_SOCKET {
                if io::Error::last_os_error().raw_os_error() != Some(WSAEWOULDBLOCK) {
                    std::thread::sleep(STOP_CHECK);
                }
                continue;
            }
            // SAFETY: `accepted` is a socket just accepted, owned by nothing else.
            let stream = unsafe { BlockingStream::from_raw_socket(accepted as u64) };
            // SAFETY: the handle is the open socket `stream` owns.
            if unsafe { SetHandleInformation(raw(&stream) as HANDLE, HANDLE_FLAG_INHERIT, 0) } == 0 {
                continue;
            }
            if tx.send(stream).is_err() {
                return;
            }
        }
    }

    pub async fn connect(path: &Path) -> io::Result<Stream> {
        let stream = connect_blocking(path)?;
        stream.set_nonblocking(true)?;
        Stream::from_std(stream)
    }

    pub fn connect_blocking(path: &Path) -> io::Result<BlockingStream> {
        let connecting = new_socket()?;
        with_address(&connecting, &address(path)?, wsa_connect)?;
        Ok(BlockingStream::from(connecting))
    }

    pub fn peer_pid(stream: &Stream) -> Option<i32> {
        let mut pid = 0u32;
        let mut written = 0u32;
        let size = u32::try_from(size_of::<u32>()).ok()?;
        // SAFETY: the socket is open; SIO_AF_UNIX_GETPEERPID takes no input and writes one u32 to `pid`.
        let failed = unsafe {
            WSAIoctl(
                raw(stream),
                SIO_AF_UNIX_GETPEERPID,
                std::ptr::null(),
                0,
                (&raw mut pid).cast(),
                size,
                &raw mut written,
                std::ptr::null_mut(),
                None,
            )
        };
        // It fills in the pid but reports no bytes written.
        (failed == 0 && pid != 0).then_some(())?;
        i32::try_from(pid).ok()
    }
}
