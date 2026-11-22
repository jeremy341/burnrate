//! Native toasts. Windows uses the WinRT toast notifier with the installer's
//! AUMID; Linux shells out to `notify-send` (libnotify via D-Bus).
//! Linux code is `cfg`-gated and UNVERIFIED here.

use std::path::PathBuf;

/// WinRT toast identity. Registered under `HKCU\Software\Classes\AppUserModelId\Burnrate` (by the shell
/// at startup and by the installers), which is what lets an unpackaged app raise toasts without a
/// shortcut that carries the AUMID property.
pub(crate) const AUMID: &str = "Burnrate";

fn escape_powershell(value: &str) -> String {
    value.replace('\'', "''").replace(['\r', '\n'], " ")
}

/// Pure builder so the escaping can be unit-tested without invoking PowerShell.
pub(crate) fn powershell_toast_script(title: &str, body: &str, severity: &str) -> String {
    format!(
        r#"[void][Reflection.Assembly]::LoadWithPartialName('Windows.UI.Notifications')
$x = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode('{title}')) | Out-Null
$t.Item(1).AppendChild($x.CreateTextNode('{body}')) | Out-Null
$n = [Windows.UI.Notifications.ToastNotification]::new($x)
$n.Tag = 'burnrate-{severity}'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{aumid}').Show($n)
"#,
        title = escape_powershell(title),
        body = escape_powershell(body),
        severity = escape_powershell(severity),
        aumid = AUMID,
    )
}

/// Register the AUMID (display name + icon) for the current user. Idempotent and cheap; a failure only
/// means toasts may not show, so it is logged, never fatal.
#[cfg(windows)]
pub(crate) fn register_aumid() {
    if let Err(error) = register_aumid_as(AUMID, "Burnrate", &std::env::current_exe().unwrap_or_default()) {
        eprintln!("toast identity registration failed: {error}");
    }
}

#[cfg(not(windows))]
pub(crate) fn register_aumid() {}

/// Testable core: `aumid` is a throwaway name in tests.
#[cfg(windows)]
pub(crate) fn register_aumid_as(aumid: &str, display_name: &str, exe: &std::path::Path) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!(r"Software\Classes\AppUserModelId\{aumid}"))?;
    key.set_value("DisplayName", &display_name)?;
    if !exe.as_os_str().is_empty() {
        key.set_value("IconUri", &exe.to_string_lossy().to_string())?;
    }
    Ok(())
}

pub(crate) fn native_toast(title: &str, body: &str, severity: &str) {
    #[cfg(windows)]
    {
        let script = powershell_toast_script(title, body, severity);
        let _ = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        // UNVERIFIED on Linux: desktop notifications need a running D-Bus
        // session and `notify-send`; failure is intentionally silent.
        let urgency = if severity == "critical" { "critical" } else { "normal" };
        let _ = std::process::Command::new("notify-send")
            .args(["-a", AUMID, "-u", urgency, title, body])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        // UNVERIFIED on macOS: `osascript` is present on every install; failure is silent.
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            applescript_escape(body),
            applescript_escape(title)
        );
        let _ = std::process::Command::new("osascript").args(["-e", &script]).spawn();
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (title, body, severity);
    }
}

/// Backslash and double quotes are the only characters that break an AppleScript string literal.
#[cfg(any(target_os = "macos", test))]
fn applescript_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Path an installer should use for the AUMID shortcut. Tests only build the
/// path with a throwaway name and delete any file they create.
#[allow(dead_code)] // helper for the installer (package 48) and tests
pub(crate) fn aumid_shortcut_path(name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let start = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        start.join(format!("{name}.lnk"))
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        home.join(".local")
            .join("share")
            .join("applications")
            .join(format!("{name}.desktop"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_script_escapes_quotes_and_newlines() {
        let script = powershell_toast_script("It's fine", "line1\nline2", "warn");
        assert!(script.contains("It''s fine"));
        assert!(script.contains("line1 line2"));
        assert!(script.contains("burnrate-warn"));
        assert!(script.contains(AUMID));
    }

    #[test]
    fn applescript_escapes_backslashes_and_quotes() {
        assert_eq!(applescript_escape(r#"a "quoted" \ path"#), r#"a \"quoted\" \\ path"#);
    }

    #[cfg(windows)]
    #[test]
    fn aumid_registration_round_trips_under_a_throwaway_name() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let aumid = format!("BurnrateTest.Aumid.{}", std::process::id());
        register_aumid_as(&aumid, "Burnrate Test", std::path::Path::new(r"C:\x\burnrate.exe")).expect("register");
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey(format!(r"Software\Classes\AppUserModelId\{aumid}")).expect("key exists");
        let name: String = key.get_value("DisplayName").expect("display name");
        assert_eq!(name, "Burnrate Test");
        let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\AppUserModelId\{aumid}"));
    }

    #[test]
    fn shortcut_path_uses_throwaway_name() {
        let path = aumid_shortcut_path("BurnrateP12Throwaway");
        assert!(path.to_string_lossy().contains("BurnrateP12Throwaway"));
        assert!(!path.exists());
    }
}
