//! Tiny 3x5 bitmap font used for the tray percentage. No image crate needed:
//! we build an RGBA buffer by hand and hand it to `tauri::image::Image`.

const GLYPHS: &[(&char, [&str; 5])] = &[
    (&'0', ["111", "101", "101", "101", "111"]),
    (&'1', ["010", "110", "010", "010", "111"]),
    (&'2', ["111", "001", "111", "100", "111"]),
    (&'3', ["111", "001", "111", "001", "111"]),
    (&'4', ["101", "101", "111", "001", "001"]),
    (&'5', ["111", "100", "111", "001", "111"]),
    (&'6', ["111", "100", "111", "101", "111"]),
    (&'7', ["111", "001", "010", "010", "010"]),
    (&'8', ["111", "101", "111", "101", "111"]),
    (&'9', ["111", "101", "111", "001", "111"]),
    (&'%', ["101", "001", "010", "100", "101"]),
    (&'-', ["000", "000", "111", "000", "000"]),
    (&'?', ["111", "001", "011", "000", "010"]),
];

/// The Burnrate logo, bundled into the binary so the window icon never depends on a resource lookup.
const APP_ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

fn has_visible_pixels(image: &tauri::image::Image<'_>) -> bool {
    image.width() > 0 && image.height() > 0 && image.rgba().chunks(4).any(|px| px[3] != 0)
}

/// Icon for the taskbar button, Alt-Tab and the window caption. Prefers the exe's own icon resource (Tauri
/// loads it at the DPI-correct size from icons/icon.ico), and falls back to the bundled 128x128 logo when
/// that lookup fails or decodes to a fully transparent image, so the taskbar can never show a blank button.
pub(crate) fn app_icon(app: &tauri::AppHandle) -> tauri::image::Image<'static> {
    app.default_window_icon()
        .filter(|icon| has_visible_pixels(icon))
        .map(|icon| icon.clone().to_owned())
        .unwrap_or_else(bundled_icon)
}

fn bundled_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(APP_ICON_PNG)
        .ok()
        .filter(has_visible_pixels)
        .unwrap_or_else(|| percent_icon(Some(100)))
}

fn glyph(c: char) -> Option<[&'static str; 5]> {
    GLYPHS.iter().find(|(key, _)| **key == c).map(|(_, g)| *g)
}

/// 16x16 RGBA image with `text` centred, or a dash when unavailable.
pub(crate) fn percent_icon(percent: Option<u32>) -> tauri::image::Image<'static> {
    let text = match percent {
        Some(p) => format!("{}%", p.min(100)),
        None => "?".to_string(),
    };
    render(&text)
}

fn render(text: &str) -> tauri::image::Image<'static> {
    const SIZE: usize = 16;
    const ACCENT: [u8; 4] = [0x9f, 0xd5, 0xfa, 0xff];
    let mut rgba = vec![0u8; SIZE * SIZE * 4];
    let chars: Vec<char> = text.chars().collect();
    let width = if chars.is_empty() { 0 } else { chars.len() * 4 - 1 }; // 3 px glyph + 1 px gap
    let x0 = (SIZE as isize - width as isize) / 2;
    let y0 = (SIZE as isize - 5) / 2;
    for (index, c) in chars.iter().enumerate() {
        let Some(rows) = glyph(*c) else { continue };
        for (row, bits) in rows.iter().enumerate() {
            for (col, bit) in bits.bytes().enumerate() {
                if bit != b'1' { continue; }
                let x = x0 + (index * 4 + col) as isize;
                let y = y0 + row as isize;
                if x < 0 || y < 0 || x >= SIZE as isize || y >= SIZE as isize { continue; }
                let offset = ((y as usize * SIZE) + x as usize) * 4;
                rgba[offset..offset + 4].copy_from_slice(&ACCENT);
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_expected_buffer() {
        let image = render("27%");
        assert_eq!(image.width(), 16);
        assert_eq!(image.height(), 16);
        assert_eq!(image.rgba().len(), 16 * 16 * 4);
        assert!(image.rgba().chunks(4).any(|px| px[3] != 0));
        let blank = render("");
        assert!(blank.rgba().chunks(4).all(|px| px[3] == 0));
    }

    #[test]
    fn bundled_logo_decodes_to_a_visible_square_icon() {
        let icon = bundled_icon();
        assert_eq!((icon.width(), icon.height()), (128, 128));
        assert!(has_visible_pixels(&icon));
        assert!(!has_visible_pixels(&render("")));
    }

    #[test]
    fn unknown_glyph_is_skipped() {
        assert!(glyph('A').is_none());
        assert!(glyph('%').is_some());
    }
}
