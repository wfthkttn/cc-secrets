//! What the kernel says of another process: its parent, when it started, what it runs, its command line. None when
//! the process is gone or can't be read.

use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod imp {
    use std::path::PathBuf;

    /// The fields of `/proc/<pid>/stat` after the command name, which may hold spaces: the state first.
    fn stat_fields(pid: i32) -> Option<Vec<String>> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        Some(stat.rsplit_once(')')?.1.split_whitespace().map(str::to_owned).collect())
    }

    pub fn parent_of(pid: i32) -> Option<i32> {
        stat_fields(pid)?.get(1)?.parse().ok()
    }

    /// In clock ticks since boot.
    pub fn start_time(pid: i32) -> Option<u64> {
        stat_fields(pid)?.get(19)?.parse().ok()
    }

    pub fn executable(pid: i32) -> Option<PathBuf> {
        std::fs::canonicalize(format!("/proc/{pid}/exe")).ok()
    }

    pub fn cmdline(pid: i32) -> Option<String> {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        Some(String::from_utf8_lossy(&raw).replace('\0', " ").trim().to_owned())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::OsStr;
    use std::mem::{MaybeUninit, size_of};
    use std::os::unix::ffi::OsStrExt as _;
    use std::path::PathBuf;

    fn bsd_info(pid: i32) -> Option<libc::proc_bsdinfo> {
        let size = libc::c_int::try_from(size_of::<libc::proc_bsdinfo>()).ok()?;
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: the buffer is a proc_bsdinfo of `size` bytes, as PROC_PIDTBSDINFO writes.
        let written = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
        // SAFETY: zeroed is a valid proc_bsdinfo (integers and byte arrays), filled in when `written` is its size.
        (written == size).then(|| unsafe { info.assume_init() })
    }

    pub fn parent_of(pid: i32) -> Option<i32> {
        i32::try_from(bsd_info(pid)?.pbi_ppid).ok()
    }

    /// In microseconds since the epoch.
    pub fn start_time(pid: i32) -> Option<u64> {
        let info = bsd_info(pid)?;
        info.pbi_start_tvsec.checked_mul(1_000_000)?.checked_add(info.pbi_start_tvusec)
    }

    pub fn executable(pid: i32) -> Option<PathBuf> {
        let mut buf = vec![0u8; usize::try_from(libc::PROC_PIDPATHINFO_MAXSIZE).ok()?];
        let size = u32::try_from(buf.len()).ok()?;
        // SAFETY: `buf` holds `size` writable bytes.
        let written = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), size) };
        let path = buf.get(..usize::try_from(written).ok().filter(|n| *n > 0)?)?;
        std::fs::canonicalize(OsStr::from_bytes(path)).ok()
    }

    /// `sysctl` with `mib` into `buf`; the bytes written.
    fn sysctl(mib: &mut [libc::c_int], buf: &mut [u8]) -> Option<usize> {
        let mut size = buf.len();
        let depth = libc::c_uint::try_from(mib.len()).ok()?;
        // SAFETY: `mib` holds `depth` names; `buf` holds `size` writable bytes, and `size` gets what was written.
        let failed = unsafe { libc::sysctl(mib.as_mut_ptr(), depth, buf.as_mut_ptr().cast(), &raw mut size, std::ptr::null_mut(), 0) };
        (failed == 0).then_some(size)
    }

    /// The argv of `sysctl kern.procargs2`, which lays out argc, the executable's path, padding, then argv.
    pub fn cmdline(pid: i32) -> Option<String> {
        let mut argmax = [0u8; size_of::<libc::c_int>()];
        sysctl(&mut [libc::CTL_KERN, libc::KERN_ARGMAX], &mut argmax)?;
        let mut buf = vec![0u8; usize::try_from(libc::c_int::from_ne_bytes(argmax)).ok()?];
        let written = sysctl(&mut [libc::CTL_KERN, libc::KERN_PROCARGS2, pid], &mut buf)?;
        let (count, rest) = buf.get(..written)?.split_first_chunk::<{ size_of::<libc::c_int>() }>()?;
        let count = usize::try_from(libc::c_int::from_ne_bytes(*count)).ok()?;
        let after_path = rest.iter().position(|b| *b == 0)?;
        let rest = rest.get(after_path..)?;
        let first = rest.get(rest.iter().position(|b| *b != 0)?..)?;
        let words: Vec<_> = first.split(|b| *b == 0).take(count).map(String::from_utf8_lossy).collect();
        Some(words.join(" ").trim().to_owned())
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt as _;
    use std::path::PathBuf;

    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation, ProcessCommandLineInformation};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, LocalFree, STATUS_INFO_LENGTH_MISMATCH, UNICODE_STRING, WAIT_TIMEOUT};
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        QueryFullProcessImageNameW, WaitForSingleObject,
    };

    /// A handle to a running process.
    struct Process(HANDLE);

    impl Process {
        fn open(pid: i32) -> Option<Self> {
            let pid = u32::try_from(pid).ok()?;
            // SAFETY: no pointers; a null handle is checked.
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                return None;
            }
            let process = Self(handle);
            // An exited process can still be opened while anyone holds a handle to it.
            // SAFETY: the handle is open with SYNCHRONIZE; a zero timeout only polls.
            (unsafe { WaitForSingleObject(process.0, 0) } == WAIT_TIMEOUT).then_some(process)
        }

        /// In 100 ns steps since 1601.
        fn created(&self) -> Option<u64> {
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            // SAFETY: the handle is open with QUERY_LIMITED_INFORMATION; each pointer is a writable FILETIME.
            let ok = unsafe { GetProcessTimes(self.0, &raw mut created, &raw mut exited, &raw mut kernel, &raw mut user) };
            (ok != 0).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: the handle is open and this value owns it.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Windows keeps a process's parent pid after the parent exits and may give it to a later process, so the parent
    /// counts only while it runs and if it started before the child.
    pub fn parent_of(pid: i32) -> Option<i32> {
        let process = Process::open(pid)?;
        // SAFETY: PROCESS_BASIC_INFORMATION is integers and pointers, so zeroed is valid.
        let mut info: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
        let size = u32::try_from(size_of::<PROCESS_BASIC_INFORMATION>()).ok()?;
        let mut written = 0u32;
        // SAFETY: the handle is open with QUERY_LIMITED_INFORMATION; `info` is a writable PROCESS_BASIC_INFORMATION of
        // `size` bytes.
        let status = unsafe { NtQueryInformationProcess(process.0, ProcessBasicInformation, (&raw mut info).cast(), size, &raw mut written) };
        if status != 0 {
            return None;
        }
        let parent = i32::try_from(info.InheritedFromUniqueProcessId).ok()?;
        (start_time(parent)? <= process.created()?).then_some(parent)
    }

    pub fn start_time(pid: i32) -> Option<u64> {
        Process::open(pid)?.created()
    }

    pub fn executable(pid: i32) -> Option<PathBuf> {
        let process = Process::open(pid)?;
        let mut buf = vec![0u16; 32768];
        let mut size = u32::try_from(buf.len()).ok()?;
        // SAFETY: the handle is open with QUERY_LIMITED_INFORMATION; `buf` holds `size` u16s, and `size` gets the count
        // written.
        let ok = unsafe { QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &raw mut size) };
        if ok == 0 {
            return None;
        }
        std::fs::canonicalize(OsString::from_wide(buf.get(..usize::try_from(size).ok()?)?)).ok()
    }

    /// Its arguments as the program reads them from its command line (`CommandLineToArgvW`, the MSVC rules), so a
    /// quote another program escaped to pass it comes back as it was.
    pub fn cmdline(pid: i32) -> Option<String> {
        let mut line = command_line(pid)?;
        if line.is_empty() {
            return Some(String::new());
        }
        line.push(0);
        let mut count = 0i32;
        // SAFETY: `line` is NUL-terminated.
        let argv = unsafe { CommandLineToArgvW(line.as_ptr(), &raw mut count) };
        if argv.is_null() {
            return None;
        }
        let words: Vec<String> = (0..usize::try_from(count).unwrap_or(0))
            .map(|i| {
                // SAFETY: `argv` holds `count` pointers, each to a NUL-terminated string.
                let word = unsafe { *argv.add(i) };
                let mut len = 0;
                // SAFETY: as above; the walk stops at the NUL.
                while unsafe { *word.add(len) } != 0 {
                    len += 1;
                }
                // SAFETY: `word` holds `len` u16s before its NUL.
                String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(word, len) })
            })
            .collect();
        // SAFETY: CommandLineToArgvW allocated `argv` with LocalAlloc, and it is read no more.
        unsafe { LocalFree(argv.cast()) };
        Some(words.join(" ").trim().to_owned())
    }

    /// The command line as the process got it: one string.
    fn command_line(pid: i32) -> Option<Vec<u16>> {
        let process = Process::open(pid)?;
        // 8-byte words: the reply starts with a UNICODE_STRING, which holds a pointer.
        let mut buf = vec![0u64; 512];
        let mut filled = false;
        for _ in 0..2 {
            let size = u32::try_from(buf.len() * 8).ok()?;
            let mut needed = 0u32;
            // SAFETY: the handle is open with QUERY_LIMITED_INFORMATION; `buf` holds `size` writable bytes.
            let status = unsafe { NtQueryInformationProcess(process.0, ProcessCommandLineInformation, buf.as_mut_ptr().cast(), size, &raw mut needed) };
            if status == 0 {
                filled = true;
                break;
            }
            if status != STATUS_INFO_LENGTH_MISMATCH {
                return None;
            }
            buf = vec![0u64; usize::try_from(needed).ok()?.div_ceil(8)];
        }
        if !filled {
            return None;
        }
        // SAFETY: the call filled the buffer, 8-byte aligned, starting with a UNICODE_STRING.
        let text = unsafe { buf.as_ptr().cast::<UNICODE_STRING>().read() };
        let chars = usize::from(text.Length) / 2;
        if chars == 0 {
            return Some(Vec::new());
        }
        let (start, base) = (text.Buffer as usize, buf.as_ptr() as usize);
        if start < base || start + chars * 2 > base + buf.len() * 8 {
            return None;
        }
        // SAFETY: `Buffer` points at `chars` u16s inside `buf`, checked above.
        Some(unsafe { std::slice::from_raw_parts(text.Buffer, chars) }.to_vec())
    }
}

pub fn parent_of(pid: i32) -> Option<i32> {
    imp::parent_of(pid)
}

/// When the process started: with the pid, it names one process, a reused pid another. Compared, never shown.
pub fn start_time(pid: i32) -> Option<u64> {
    imp::start_time(pid)
}

/// The canonical path of the executable it runs.
pub fn executable(pid: i32) -> Option<PathBuf> {
    imp::executable(pid)
}

/// Its arguments, joined with spaces.
pub fn cmdline(pid: i32) -> Option<String> {
    imp::cmdline(pid)
}

/// The executable is a Git Bash shell by its name: `bash.exe`, or `sh.exe`, which `CLAUDE_CODE_GIT_BASH_PATH` may
/// name too.
#[cfg(windows)]
pub fn is_git_bash(exe: &std::path::Path) -> bool {
    exe.file_name().is_some_and(|name| name.eq_ignore_ascii_case("bash.exe") || name.eq_ignore_ascii_case("sh.exe"))
}
