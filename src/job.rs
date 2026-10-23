//! The job a Bash call's processes run in, on Windows. Git Bash's programs drop out of the line of parents Windows
//! keeps (one that execs another MSYS program exits), so the relay can't always walk from a requester up to its call's
//! `secrets-mask-run`; a job holds every process started inside it. It allows no breakaway: Git Bash would take it for
//! every program it starts, and a program that asks for it fails to start.

use std::io;
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};

use windows_sys::Win32::Foundation::{DuplicateHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob};
use windows_sys::Win32::System::SystemServices::JOB_OBJECT_QUERY;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE, PROCESS_QUERY_LIMITED_INFORMATION};

pub struct Job(OwnedHandle);

fn open_process(pid: i32, access: u32) -> Option<OwnedHandle> {
    let pid = u32::try_from(pid).ok()?;
    // SAFETY: no pointers; a null handle is checked.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    // SAFETY: a handle just opened, owned by nothing else.
    (!handle.is_null()).then(|| unsafe { OwnedHandle::from_raw_handle(handle) })
}

impl Job {
    /// A new job this process joins, so every process it starts from now on runs in it.
    pub fn join_new() -> io::Result<Self> {
        // SAFETY: no security attributes and no name.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a handle just created, owned by nothing else.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        // SAFETY: the job handle has all access; the pseudo handle names this process with all access.
        if unsafe { AssignProcessToJobObject(job.handle(), GetCurrentProcess()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// The handle's value in this process, for `of` in another.
    pub fn value(&self) -> usize {
        self.handle() as usize
    }

    /// The job behind the handle `value` of the process `pid`, when that job holds `pid`.
    pub fn of(pid: i32, value: usize) -> Option<Self> {
        let process = open_process(pid, PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut handle: HANDLE = std::ptr::null_mut();
        // SAFETY: the process handle is open with DUP_HANDLE; `handle` is writable. A value that names no handle there
        // fails the call.
        let ok = unsafe { DuplicateHandle(process.as_raw_handle(), value as HANDLE, GetCurrentProcess(), &raw mut handle, JOB_OBJECT_QUERY, 0, 0) };
        if ok == 0 {
            return None;
        }
        // SAFETY: a handle just duplicated into this process, owned by nothing else.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        job.runs(&process).then_some(job)
    }

    /// The process `pid` runs in the job.
    pub fn holds(&self, pid: i32) -> bool {
        open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION).is_some_and(|process| self.runs(&process))
    }

    /// False too when the handle isn't a job's.
    fn runs(&self, process: &OwnedHandle) -> bool {
        let mut inside = 0;
        // SAFETY: the process handle is open with QUERY_LIMITED_INFORMATION, the job's with QUERY; `inside` is writable.
        let ok = unsafe { IsProcessInJob(process.as_raw_handle(), self.handle(), &raw mut inside) };
        ok != 0 && inside != 0
    }

    fn handle(&self) -> HANDLE {
        self.0.as_raw_handle()
    }
}
