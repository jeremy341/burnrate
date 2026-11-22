//! Global shortcuts: the app shortcut focuses/opens the main window (`shell.globalShortcut`,
//! e.g. "Ctrl+Shift+B"). It is applied live from the settings stream — no polling. Windows is
//! verified here; Linux/Wayland global shortcuts are UNVERIFIED and intentionally disabled
//! rather than guessed.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::AppHandle;

/// Win32 modifier bit values. Kept local so the pure parser compiles and tests on any OS.
pub(crate) const MOD_ALT: u32 = 0x0001;
pub(crate) const MOD_CONTROL: u32 = 0x0002;
pub(crate) const MOD_SHIFT: u32 = 0x0004;
pub(crate) const MOD_WIN: u32 = 0x0008;

const MAIN_HOTKEY_ID: i32 = 0x4252; // 'BR': focus / open the main window

/// A parsed hotkey: modifier bitmask + Win32 virtual key code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Hotkey {
    pub modifiers: u32,
    pub key: u32,
}

/// The combos the settings stream last asked for, per slot. The hotkey thread reads this on
/// wake and on startup, so a settings event arriving before the thread starts is never lost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DesiredHotkeys {
    /// `shell.globalShortcut`: open / focus the main window.
    pub main: Option<Hotkey>,
}

static DESIRED: Mutex<DesiredHotkeys> = Mutex::new(DesiredHotkeys { main: None });
/// Thread id of the hotkey message loop: 0 until its queue exists, 0 again once it exits.
static HOTKEY_THREAD: AtomicU32 = AtomicU32::new(0);

/// Map one combo token (already lower-cased) to a Win32 virtual key code.
fn key_vk(token: &str) -> Option<u32> {
    let bytes = token.as_bytes();
    if bytes.len() == 1 {
        let byte = bytes[0];
        if byte.is_ascii_lowercase() {
            return Some(0x41 + (byte - b'a') as u32); // 'a'..'z' -> VK_A..VK_Z
        }
        if byte.is_ascii_digit() {
            return Some(0x30 + (byte - b'0') as u32); // '0'..'9' -> VK_0..VK_9
        }
    }
    // F1-F12 only: higher function keys are deliberately unsupported.
    if let Some(number) = token.strip_prefix('f') {
        if let Ok(value) = number.parse::<u32>() {
            if (1..=12).contains(&value) {
                return Some(0x70 + value - 1); // VK_F1..VK_F12
            }
        }
    }
    Some(match token {
        " " | "space" | "spacebar" => 0x20, // VK_SPACE
        "escape" | "esc" => 0x1B,           // VK_ESCAPE
        "arrowup" | "up" => 0x26,           // VK_UP
        "arrowdown" | "down" => 0x28,       // VK_DOWN
        "arrowleft" | "left" => 0x25,       // VK_LEFT
        "arrowright" | "right" => 0x27,     // VK_RIGHT
        "pageup" => 0x21,                   // VK_PRIOR
        "pagedown" => 0x22,                 // VK_NEXT
        "home" => 0x24,                     // VK_HOME
        "end" => 0x23,                      // VK_END
        "enter" | "return" => 0x0D,         // VK_RETURN
        "tab" => 0x09,                      // VK_TAB
        "backspace" => 0x08,                // VK_BACK
        "delete" | "del" => 0x2E,           // VK_DELETE
        "insert" | "ins" => 0x2D,           // VK_INSERT
        "pause" => 0x13,                    // VK_PAUSE
        "printscreen" | "print" => 0x2C,    // VK_SNAPSHOT
        _ => return None,
    })
}

/// Parse a stored combo ("Ctrl+Shift+B", "mod+shift+1", "Alt+F4") into modifiers + key.
/// `None` means "not a usable hotkey" — modifier-only, Shift-only (it would steal normal
/// typing), malformed or unsupported combos. Callers keep the previously registered key.
pub(crate) fn parse_hotkey(combo: &str) -> Option<Hotkey> {
    let mut modifiers = 0u32;
    let mut key = None;
    let mut has_primary = false;
    for raw in combo.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return None;
        }
        match token.to_ascii_lowercase().as_str() {
            "mod" | "ctrl" | "control" => {
                modifiers |= MOD_CONTROL;
                has_primary = true;
            }
            "alt" | "option" => {
                modifiers |= MOD_ALT;
                has_primary = true;
            }
            "shift" => modifiers |= MOD_SHIFT,
            "meta" | "cmd" | "command" | "win" => {
                modifiers |= MOD_WIN;
                has_primary = true;
            }
            other => {
                if key.is_some() {
                    return None; // more than one non-modifier token
                }
                key = Some(key_vk(other)?);
            }
        }
    }
    let key = key?; // a modifier-only press is not a hotkey
    if !has_primary {
        return None; // Ctrl / Alt / Win required; Shift alone is unusable globally
    }
    Some(Hotkey { modifiers, key })
}

/// What the `shell.globalShortcut` settings slot asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot {
    /// Register this combo.
    Valid(Hotkey),
    /// null / empty / missing: unregister.
    Off,
    /// Unusable value; the caller keeps the previous registration.
    Invalid,
}

fn read_slot(value: Option<&Value>) -> Slot {
    match value {
        None | Some(Value::Null) => Slot::Off,
        Some(Value::String(text)) if text.trim().is_empty() => Slot::Off,
        Some(Value::String(text)) => match parse_hotkey(text.trim()) {
            Some(hotkey) => Slot::Valid(hotkey),
            None => {
                eprintln!("ignoring unsupported shortcut {text:?}; keeping the previous one");
                Slot::Invalid
            }
        },
        Some(other) => {
            eprintln!("ignoring non-string shortcut {other:?}; keeping the previous one");
            Slot::Invalid
        }
    }
}

/// The desired hotkeys from a settings document. Invalid combos keep the previous registration.
fn desired_from_settings(settings: &Value, previous: DesiredHotkeys) -> DesiredHotkeys {
    let main = match read_slot(settings.pointer("/shell/globalShortcut")) {
        Slot::Valid(combo) => Some(combo),
        Slot::Off => None,
        Slot::Invalid => previous.main,
    };
    DesiredHotkeys { main }
}

/// Apply `shell.globalShortcut` from a settings document. Called on the initial settings load
/// and on every SSE `settings` event — never on a timer. An invalid combo leaves the current
/// hotkey untouched; null / empty disables it.
pub(crate) fn apply_from_settings(settings: &Value) {
    let mut guard = DESIRED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let desired = desired_from_settings(settings, *guard);
    if desired == *guard {
        return; // no unregister/re-register churn on unrelated settings edits
    }
    *guard = desired;
    drop(guard);
    wake();
}

/// Wake the hotkey thread so it re-reads DESIRED. No-op until the thread's queue exists.
#[cfg(windows)]
fn wake() {
    let thread = HOTKEY_THREAD.load(Ordering::Acquire);
    if thread == 0 {
        return;
    }
    unsafe {
        // WM_APP + 1 is a private message; any non-hotkey message makes the loop
        // re-check DESIRED, which is the single source of truth for the new combo.
        const WM_REBIND: u32 = 0x8000 + 1;
        use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
        if PostThreadMessageW(thread, WM_REBIND, Default::default(), Default::default()).is_err() {
            eprintln!("could not wake the hotkey thread");
        }
    }
}

#[cfg(not(windows))]
fn wake() {}

pub(crate) fn start(app: AppHandle) {
    #[cfg(windows)]
    start_windows(app);
    #[cfg(not(windows))]
    {
        // UNVERIFIED on Linux: no global shortcut without a desktop-portal
        // grant; the tray and the `burnrate://open` link still work.
        let _ = app;
    }
}

#[cfg(windows)]
fn start_windows(app: AppHandle) {
    std::thread::Builder::new()
        .name("burnrate-hotkey".into())
        .spawn(move || unsafe {
            use windows::Win32::System::Threading::GetCurrentThreadId;
            use windows::Win32::UI::Input::KeyboardAndMouse::UnregisterHotKey;
            use windows::Win32::UI::WindowsAndMessaging::{
                GetMessageW, PeekMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_USER,
            };

            // Force this thread's message queue into existence before publishing its id,
            // so a wake posted from the settings stream can never be lost to a race.
            let mut seed = MSG::default();
            let _ = PeekMessageW(&mut seed, None, WM_USER, WM_USER, PM_NOREMOVE);
            HOTKEY_THREAD.store(GetCurrentThreadId(), Ordering::Release);

            let mut applied = DesiredHotkeys::default();
            loop {
                // Apply the latest desired combos. This also covers startup: a settings
                // event may have set DESIRED before this thread ever ran.
                let desired = DESIRED.lock().map(|guard| *guard).unwrap_or_default();
                rebind(MAIN_HOTKEY_ID, desired.main, &mut applied.main);

                let mut message = MSG::default();
                let status = GetMessageW(&mut message, None, 0, 0);
                if status.0 <= 0 {
                    break; // WM_QUIT or error
                }
                if message.message == WM_HOTKEY && message.wParam.0 as i32 == MAIN_HOTKEY_ID {
                    crate::windows::open_main(&app, None);
                }
                // Any other message (notably our private wake) just loops back to the
                // re-check above.
            }

            HOTKEY_THREAD.store(0, Ordering::Release);
            if applied.main.is_some() {
                let _ = UnregisterHotKey(None, MAIN_HOTKEY_ID);
            }
        })
        .ok();
}

/// Bring `id`'s registration in line with `desired`, restoring the previous combo when the OS
/// refuses the new one (already taken by another application, for instance). Shared by both
/// hotkey slots.
#[cfg(windows)]
unsafe fn rebind(id: i32, desired: Option<Hotkey>, applied: &mut Option<Hotkey>) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS};

    if desired == *applied {
        return;
    }
    if applied.is_some() {
        let _ = UnregisterHotKey(None, id); // always unregister the old combo first
    }
    let mut registered = true;
    if let Some(next) = desired {
        if RegisterHotKey(None, id, HOT_KEY_MODIFIERS(next.modifiers), next.key).is_err() {
            eprintln!("could not register global shortcut (possibly already taken)");
            registered = false;
        }
    }
    if registered {
        *applied = desired;
    } else if let Some(old) = *applied {
        // The OS refused the new combo: restore the previous hotkey.
        let _ = RegisterHotKey(None, id, HOT_KEY_MODIFIERS(old.modifiers), old.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_letters_digits_and_modifier_aliases() {
        assert_eq!(
            parse_hotkey("Ctrl+Shift+B"),
            Some(Hotkey { modifiers: MOD_CONTROL | MOD_SHIFT, key: 0x42 })
        );
        // Case, surrounding whitespace and T3's `mod` alias are tolerated.
        assert_eq!(
            parse_hotkey(" mod + shift + 1 "),
            Some(Hotkey { modifiers: MOD_CONTROL | MOD_SHIFT, key: 0x31 })
        );
        assert_eq!(
            parse_hotkey("Alt+F4"),
            Some(Hotkey { modifiers: MOD_ALT, key: 0x73 })
        );
        assert_eq!(
            parse_hotkey("Cmd+9"),
            Some(Hotkey { modifiers: MOD_WIN, key: 0x39 })
        );
    }

    #[test]
    fn parses_common_named_keys() {
        assert_eq!(
            parse_hotkey("Ctrl+Escape"),
            Some(Hotkey { modifiers: MOD_CONTROL, key: 0x1B })
        );
        assert_eq!(
            parse_hotkey("Ctrl+space"),
            Some(Hotkey { modifiers: MOD_CONTROL, key: 0x20 })
        );
        assert_eq!(
            parse_hotkey("Alt+ArrowUp"),
            Some(Hotkey { modifiers: MOD_ALT, key: 0x26 })
        );
        assert_eq!(
            parse_hotkey("Ctrl+PageDown"),
            Some(Hotkey { modifiers: MOD_CONTROL, key: 0x22 })
        );
    }

    #[test]
    fn rejects_modifier_only_shift_only_and_unsupported_combos() {
        assert_eq!(parse_hotkey("Ctrl+Shift"), None); // no key
        assert_eq!(parse_hotkey("Shift+B"), None); // Shift alone steals typing
        assert_eq!(parse_hotkey("B"), None); // no modifier
        assert_eq!(parse_hotkey("Ctrl+Shift+F13"), None); // beyond F1-F12
        assert_eq!(parse_hotkey("Ctrl+"), None); // empty segment
        assert_eq!(parse_hotkey("Ctrl+A+B"), None); // two keys
        assert_eq!(parse_hotkey("Ctrl+MediaNextTrack"), None); // unknown name
        assert_eq!(parse_hotkey(""), None);
    }

    #[test]
    fn settings_apply_valid_but_keep_previous_on_bad_values() {
        // A valid combo becomes the desired app hotkey.
        apply_from_settings(&json!({"shell": {"globalShortcut": "Ctrl+Alt+K"}}));
        let expected = Some(Hotkey { modifiers: MOD_CONTROL | MOD_ALT, key: 0x4B });
        let seen = *DESIRED.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(seen.main, expected);
        // An unsupported combo is ignored — the previous hotkey stays.
        apply_from_settings(&json!({"shell": {"globalShortcut": "Shift+Z"}}));
        assert_eq!(DESIRED.lock().unwrap_or_else(|e| e.into_inner()).main, expected);
        // Non-string values are ignored too.
        apply_from_settings(&json!({"shell": {"globalShortcut": 42}}));
        assert_eq!(DESIRED.lock().unwrap_or_else(|e| e.into_inner()).main, expected);
        // Null, empty and missing values disable the hotkey.
        apply_from_settings(&json!({"shell": {"globalShortcut": null}}));
        assert_eq!(DESIRED.lock().unwrap_or_else(|e| e.into_inner()).main, None);
        apply_from_settings(&json!({"shell": {"globalShortcut": "  "}}));
        assert_eq!(DESIRED.lock().unwrap_or_else(|e| e.into_inner()).main, None);
        apply_from_settings(&json!({"shell": {}}));
        assert_eq!(DESIRED.lock().unwrap_or_else(|e| e.into_inner()).main, None);
    }

}
