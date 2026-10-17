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
