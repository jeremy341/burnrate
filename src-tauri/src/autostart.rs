//! Launch-at-login. Windows uses the per-user Run key (`Burnrate`), Linux
//! writes an autostart .desktop file. No admin rights, no installer executed
//! here; tests use throwaway names and remove what they create.

use std::io;
use std::path::Path;

pub(crate) const RUN_VALUE: &str = "Burnrate";

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
pub(crate) fn set_enabled(enabled: bool) {
    if let Err(error) = set_enabled_as(RUN_VALUE, enabled, &current_exe()) {
        eprintln!("autostart update failed: {error}");
    }
}

#[cfg(not(windows))]
pub(crate) fn set_enabled(enabled: bool) {
    // UNVERIFIED on Linux/Wayland: many desktops ignore or gate autostart
    // entries; we write the standard XDG file and never assume it took effect.
    if let Err(error) = set_enabled_as(RUN_VALUE, enabled, &current_exe()) {
        eprintln!("autostart update failed: {error}");
    }
}

fn current_exe() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_default()
}

/// Testable entry point: `name` is a throwaway value in tests.
#[cfg(windows)]
pub(crate) fn set_enabled_as(name: &str, enabled: bool, exe: &Path) -> io::Result<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_SET_VALUE)?;
    if enabled {
        let command = format!("\"{}\"", exe.to_string_lossy());
        key.set_value(name, &command)
    } else {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// Testable entry point: `name` is a throwaway file stem in tests.
#[cfg(all(not(windows), not(target_os = "macos")))]
pub(crate) fn set_enabled_as(name: &str, enabled: bool, exe: &Path) -> io::Result<()> {
    let path = desktop_entry_path(name)?;
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, desktop_entry_contents(name, exe))
    } else if path.exists() {
        std::fs::remove_file(path)
    } else {
        Ok(())
    }
}

/// macOS launch-at-login is a per-user LaunchAgent plist.
#[cfg(target_os = "macos")]
pub(crate) fn set_enabled_as(name: &str, enabled: bool, exe: &Path) -> io::Result<()> {
    let path = launch_agent_path(name)?;
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, launch_agent_contents(name, exe))
    } else if path.exists() {
        std::fs::remove_file(path)
    } else {
        Ok(())
    }
}

#[allow(dead_code)] // used on macOS and in tests
pub(crate) fn launch_agent_path(name: &str) -> io::Result<std::path::PathBuf> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
    Ok(home.join("Library").join("LaunchAgents").join(format!("{name}.plist")))
}

#[allow(dead_code)] // used on macOS and in tests
pub(crate) fn launch_agent_contents(name: &str, exe: &Path) -> String {
    let exe = xml_escape(&exe.to_string_lossy());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\"><dict>\n\
         <key>Label</key><string>{name}</string>\n\
         <key>ProgramArguments</key><array><string>{exe}</string></array>\n\
         <key>RunAtLoad</key><true/>\n\
         </dict></plist>\n"
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[allow(dead_code)] // used on non-Windows targets and in tests
pub(crate) fn desktop_entry_contents(name: &str, exe: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={}\nTerminal=false\nCategories=Utility;\n",
        exe.to_string_lossy()
    )
}

#[allow(dead_code)] // used on non-Windows targets and in tests
pub(crate) fn desktop_entry_path(name: &str) -> io::Result<std::path::PathBuf> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
    Ok(home.join(".config").join("autostart").join(format!("{name}.desktop")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn desktop_entry_has_no_trailing_newline_issue() {
        let body = desktop_entry_contents("BurnrateTest", Path::new("C:/tmp/burnrate.exe"));
        assert!(body.contains("Name=BurnrateTest"));
        assert!(body.contains("Exec="));
        assert!(body.ends_with('\n'));
    }

    #[test]
    fn desktop_entry_path_is_under_autostart() {
        let path = desktop_entry_path("BurnrateP12Throwaway").unwrap();
        assert!(path.to_string_lossy().contains("autostart"));
        assert!(path.to_string_lossy().ends_with("BurnrateP12Throwaway.desktop"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_toggle_uses_throwaway_name_and_cleans_up() {
        // UNVERIFIED on Linux: write with a throwaway name, then remove it.
        let name = "BurnrateP12Throwaway";
        let exe = PathBuf::from("/usr/bin/burnrate");
        set_enabled_as(name, true, &exe).unwrap();
        let path = desktop_entry_path(name).unwrap();
        assert!(path.is_file());
        set_enabled_as(name, false, &exe).unwrap();
        assert!(!path.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_toggle_writes_a_launch_agent_and_cleans_up() {
        let name = "BurnrateP12Throwaway";
        let exe = PathBuf::from("/Applications/Burnrate.app/Contents/MacOS/Burnrate & Co");
        set_enabled_as(name, true, &exe).unwrap();
        let path = launch_agent_path(name).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("<key>RunAtLoad</key><true/>"));
        assert!(body.contains("Burnrate &amp; Co"), "the executable is XML-escaped");
        set_enabled_as(name, false, &exe).unwrap();
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_toggle_uses_throwaway_name_and_cleans_up() {
        // HKCU Run only; the value is removed in the same test run.
        let name = "BurnrateP12Throwaway";
        let exe = PathBuf::from("C:/burnrate-test/burnrate.exe");
        set_enabled_as(name, true, &exe).unwrap();
        set_enabled_as(name, false, &exe).unwrap();
    }
}
