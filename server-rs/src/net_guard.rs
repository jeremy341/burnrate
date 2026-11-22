//! Outbound-request safety shared by every feature that calls user-configurable URLs.
//! Owned by the security work package; the contract (signatures) is fixed in docs/CONTRACTS.md.

use regex::Regex;
use std::net::{IpAddr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::OnceLock;
use url::{Host, Url};

/// Validates a user-configurable URL: https only (http allowed for 127.0.0.1/localhost), no credentials in the URL,
/// no private/link-local/metadata addresses unless `allow_local`, and when `bound_host` is set the URL host must equal it.
/// DNS is resolved here and every answer is checked. This is only a check-time gate: agents that fetch
/// user-configurable URLs should also install [`GuardedResolver`] so the addresses are validated again
/// at connect time and the validated set is the one actually dialled (no re-resolution / rebinding gap).
/// Returns the normalised URL (`Url::to_string`), which callers should use instead of the original string.
pub fn check_url(url: &str, bound_host: Option<&str>, allow_local: bool) -> Result<String, String> {
    // Percent-encoded delimiters in the authority have been used to smuggle a different host past parsers.
    let authority = url.split_once("://").map(|(_, rest)| rest.split('/').next().unwrap_or("")).unwrap_or("");
    if authority.contains('%') || authority.contains('\\') {
        return Err("encoded characters are not allowed in the URL host".into());
    }

    let parsed = Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    match parsed.scheme() {
        "https" => {}
        // Plain http is only for loopback test stubs, and only when the caller opted into local access.
        "http" if allow_local => {}
        _ => return Err("only https URLs are allowed (http only to loopback with allow_local)".into()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs with credentials are not allowed".into());
    }

    let host = parsed.host().ok_or_else(|| "URL has no host".to_string())?;
    if parsed.scheme() == "http" && !is_loopback(&host) {
        return Err("http is only allowed to loopback hosts".into());
    }
    if let Some(bound) = bound_host {
        if !host_matches_bound(&host, bound) {
            return Err("URL host is not allowed for this key".into());
        }
    }
    let port = parsed.port_or_known_default().unwrap_or(80);

    match &host {
        Host::Ipv4(ip) => check_ip(IpAddr::V4(*ip), allow_local)?,
        Host::Ipv6(ip) => check_ip(IpAddr::V6(*ip), allow_local)?,
        Host::Domain(domain) => {
            if is_metadata_domain(domain) {
                return Err("cloud metadata hosts are not allowed".into());
            }
            // Resolve once and refuse if any answer is private. We do not hand the addresses back
            // to the caller; the point is to reject a name that currently points inside the network.
            let answers: Vec<SocketAddr> = (*domain, port)
                .to_socket_addrs()
                .map_err(|e| format!("could not resolve host: {e}"))?
                .collect();
            if answers.is_empty() {
                return Err("host did not resolve to an address".into());
            }
            for answer in answers {
                check_ip(answer.ip(), allow_local)?;
            }
        }
    }

    Ok(parsed.to_string())
}

fn check_ip(ip: IpAddr, allow_local: bool) -> Result<(), String> {
    // Cloud metadata is never reachable, even for a caller that opted into local addresses.
    if is_metadata_ip(&ip) {
        return Err("cloud metadata addresses are not allowed".into());
    }
    if is_private_ip(&ip) && !allow_local {
        return Err("private, loopback or link-local addresses are not allowed".into());
    }
    Ok(())
}

/// A ureq resolver that re-validates DNS answers at connect time and hands those exact addresses to
/// ureq. `check_url` on its own only validates at check time; without this a name can be re-resolved
/// to a private address in the gap before the connection. Install this on every agent used for
/// user-configurable URLs, together with `.redirects(0)` and a disabled environment proxy (otherwise
/// ureq resolves the proxy host instead of the target).
pub struct GuardedResolver {
    pub allow_local: bool,
}

impl ureq::Resolver for GuardedResolver {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
        if addrs.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "host did not resolve"));
        }
        for addr in &addrs {
            check_ip(addr.ip(), self.allow_local)
                .map_err(|msg| std::io::Error::new(std::io::ErrorKind::PermissionDenied, msg))?;
        }
        // The same validated addresses are returned to ureq, so there is no second lookup to rebind.
        Ok(addrs)
    }
}

/// True for loopback, private, link-local, unique-local and cloud-metadata addresses.
pub fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || o[0] == 0 // 0.0.0.0/8
                || (o[0] == 100 && (64..=127).contains(&o[1])) // 100.64.0.0/10 (CGNAT, incl. Alibaba metadata)
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // fc00::/7, covers fd00::/8 unique-local
                || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                || v6.to_ipv4_mapped().is_some_and(|v4| is_private_ip(&IpAddr::V4(v4)))
        }
    }
}

/// Cloud metadata endpoints stay blocked even for `allow_local` callers.
fn is_metadata_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o == [169, 254, 169, 254] // AWS/GCP/Azure IMDS
                || o == [169, 254, 170, 2] // AWS ECS task metadata
                || o == [100, 100, 100, 200] // Alibaba Cloud metadata
        }
        IpAddr::V6(v6) => {
            v6 == &Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254) // AWS IPv6 IMDS
                || v6.to_ipv4_mapped().is_some_and(|v4| is_metadata_ip(&IpAddr::V4(v4)))
        }
    }
}

fn is_metadata_domain(domain: &str) -> bool {
    let d = domain.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        d.as_str(),
        "metadata" | "metadata.google.internal" | "metadata.goog" | "instance-data" | "instance-data.ec2.internal" | "metadata.azure.com"
    )
}

fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(v4) => v4.is_loopback(),
        Host::Ipv6(v6) => v6.is_loopback(),
        Host::Domain(domain) => domain.trim_end_matches('.').eq_ignore_ascii_case("localhost"),
    }
}

/// Exact or subdomain match (case-insensitive), with a literal-IP special case.
fn host_matches_bound(host: &Host<&str>, bound_host: &str) -> bool {
    let bound = bound_host.trim_end_matches('.').to_ascii_lowercase();
    match host {
        Host::Ipv4(ip) => bound.parse::<IpAddr>().is_ok_and(|b| b == IpAddr::V4(*ip)),
        Host::Ipv6(ip) => bound.parse::<IpAddr>().is_ok_and(|b| b == IpAddr::V6(*ip)),
        Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            domain == bound || domain.ends_with(&format!(".{bound}"))
        }
    }
}

struct Redactor {
    pattern: Regex,
    replacement: &'static str,
}

fn redactors() -> &'static [Redactor] {
    static REDACTORS: OnceLock<Vec<Redactor>> = OnceLock::new();
    REDACTORS.get_or_init(|| {
        // Order matters: scrub token-shaped values first, then remove the labels that may surround them.
        const PATTERNS: &[(&str, &str)] = &[
            (r#"(?i)\bBearer\s+[^\s,;"'\r\n]{4,}"#, "Bearer [redacted]"),
            (r"\b(?:sk-(?:ant-|or-v1-|admin-)?[A-Za-z0-9_\-]{8,}|gsk_[A-Za-z0-9_\-]{8,}|xai-[A-Za-z0-9_\-]{8,}|AIza[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|pplx-[A-Za-z0-9_\-]{8,}|kimi-[A-Za-z0-9_\-]{8,})", "[redacted]"),
            (r"\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}", "[redacted]"),
            (r#"(?i)\b(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie)\s*[:=]\s*[^\r\n,;]{1,300}"#, "${1}: [redacted]"),
            (r#"(?i)(\?|&|^)?\b(key|api_key|apiKey|token|access_token)=[^&\s#]+"#, "${1}${2}=[redacted]"),
            (r"\b[0-9a-fA-F]{32,}\b", "[redacted]"),
            (r"\b[A-Za-z0-9+/]{40,}={0,2}", "[redacted]"),
        ];
        PATTERNS
            .iter()
            .map(|(pattern, replacement)| Redactor { pattern: Regex::new(pattern).expect("valid redaction pattern"), replacement })
            .collect()
    })
}

/// Replaces anything that looks like a secret (bearer tokens, sk-/key-style strings, JWTs,
/// long hex/base64 strings, credential headers and query parameters) with `[redacted]`.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for rule in redactors() {
        out = rule.pattern.replace_all(&out, rule.replacement).into_owned();
    }
    out
}

/// Like [`redact`], but also removes the literal stored secret values handed in by the caller.
/// Longest values are removed first so a short value cannot leave a fragment of a longer one behind.
pub fn redact_with(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    let mut values: Vec<&str> = secrets.iter().map(String::as_str).filter(|v| !v.is_empty()).collect();
    values.sort_by(|a, b| b.len().cmp(&a.len()));
    for value in values {
        out = out.replace(value, "[redacted]");
    }
    redact(&out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn rejects_non_https_schemes() {
        assert!(check_url("http://example.com/", None, true).is_err());
        assert!(check_url("ftp://example.com/", None, true).is_err());
        assert!(check_url("file:///etc/passwd", None, true).is_err());
        assert_eq!(check_url("https://127.0.0.1/", None, true).unwrap(), "https://127.0.0.1/");
    }

    #[test]
    fn http_is_only_allowed_to_loopback_with_allow_local() {
        assert!(check_url("http://127.0.0.1:13805/path", None, false).is_err());
        assert!(check_url("http://[::1]:13805/path", None, false).is_err());
        assert_eq!(check_url("http://127.0.0.1:13805/path", None, true).unwrap(), "http://127.0.0.1:13805/path");
        assert_eq!(check_url("http://localhost:13805/", None, true).unwrap(), "http://localhost:13805/");
        // Even with allow_local, plain http may not reach a non-loopback host.
        assert!(check_url("http://10.0.0.5/", None, true).is_err());
        assert!(check_url("http://example.com/", None, true).is_err());
    }

    #[test]
    fn refuses_credentials_and_encoded_host_delimiters() {
        assert!(check_url("https://user:pass@127.0.0.1/", None, true).is_err());
        assert!(check_url("https://user@127.0.0.1/", None, true).is_err());
        assert!(check_url("https://127.0.0.1%2f.evil.com/", None, true).is_err());
        assert!(check_url("https://127.0.0.1%40evil.com/", None, true).is_err());
        assert!(check_url("https://127.0.0.1\\@evil.com/", None, true).is_err());
    }

    #[test]
    fn refuses_private_ip_literals_unless_allow_local() {
        for raw in ["127.0.0.1", "10.0.0.5", "172.16.5.4", "192.168.1.1", "169.254.10.20", "0.0.0.0", "100.64.0.1", "[::1]", "[fd00::1]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"] {
            let url = format!("https://{raw}/path");
            assert!(check_url(&url, None, false).is_err(), "{url} should be refused");
            // allow_local re-enables the private ranges the user explicitly typed.
            assert!(check_url(&url, None, true).is_ok(), "{url} should be allowed with allow_local");
        }
    }

    #[test]
    fn metadata_addresses_are_never_allowed() {
        for raw in ["169.254.169.254", "169.254.170.2", "100.100.100.200", "[fd00:ec2::254]", "[::ffff:169.254.169.254]"] {
            let url = format!("https://{raw}/");
            assert!(check_url(&url, None, false).is_err(), "{url} should be refused");
            assert!(check_url(&url, None, true).is_err(), "{url} must stay refused with allow_local");
        }
        assert!(check_url("https://metadata.google.internal/", None, true).is_err());
        assert!(check_url("https://metadata.google.internal./", None, true).is_err());
    }

    #[test]
    fn checks_dns_answers_to_block_rebinding_names() {
        // localhost resolves on every platform via the hosts file, with no network needed.
        assert!(check_url("https://localhost/", None, false).is_err(), "localhost resolves to a private IP");
        assert!(check_url("https://localhost/", None, true).is_ok());
        // A name that cannot resolve is refused rather than passed through.
        assert!(check_url("https://this-host-does-not-exist.invalid/", None, true).is_err());
    }

    #[test]
    fn connect_time_resolver_revalidates_and_pins_addresses() {
        use ureq::Resolver;
        let guarded = GuardedResolver { allow_local: false };
        // Literal addresses need no network: a private or metadata answer is refused at connect time.
        assert!(guarded.resolve("127.0.0.1:443").is_err());
        assert!(guarded.resolve("10.0.0.5:443").is_err());
        assert!(guarded.resolve("169.254.169.254:80").is_err());
        let pinned = guarded.resolve("1.1.1.1:443").expect("public literal is allowed");
        assert_eq!(pinned.len(), 1);
        assert_eq!(pinned[0].ip().to_string(), "1.1.1.1");

        // `allow_local` re-enables private ranges but never metadata endpoints.
        let local = GuardedResolver { allow_local: true };
        assert!(local.resolve("127.0.0.1:443").is_ok());
        assert!(local.resolve("169.254.169.254:80").is_err());
    }

    #[test]
    fn bound_host_is_exact_or_subdomain() {
        let bound = "openrouter.ai";
        assert!(host_matches_bound(&Host::Domain("openrouter.ai"), bound));
        assert!(host_matches_bound(&Host::Domain("api.openrouter.ai"), bound));
        assert!(host_matches_bound(&Host::Domain("API.OPENROUTER.AI."), bound));
        assert!(!host_matches_bound(&Host::Domain("evilopenrouter.ai"), bound));
        assert!(!host_matches_bound(&Host::Domain("openrouter.ai.evil.com"), bound));
        assert!(host_matches_bound(&Host::Ipv4(Ipv4Addr::new(127, 0, 0, 1)), "127.0.0.1"));
        assert!(!host_matches_bound(&Host::Ipv4(Ipv4Addr::new(127, 0, 0, 1)), "localhost"));

        // The real route applies the same rule (localhost resolves without network access).
        assert!(check_url("https://localhost/", Some("localhost"), true).is_ok());
        assert!(check_url("https://localhost/", Some("example.com"), true).is_err());
    }

    #[test]
    fn returns_a_normalised_url() {
        // An IP literal keeps this test offline while still exercising canonicalisation.
        assert_eq!(check_url("https://127.0.0.1:443/a/./b/../c", Some("127.0.0.1"), true).unwrap(), "https://127.0.0.1/a/c");
    }

    #[test]
    fn private_ip_classification_covers_all_required_ranges() {
        for raw in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "224.0.0.1"] {
            assert!(is_private_ip(&raw.parse::<IpAddr>().unwrap()), "{raw}");
        }
        assert!(!is_private_ip(&"8.8.8.8".parse::<IpAddr>().unwrap()));
        assert!(!is_private_ip(&"172.32.0.1".parse::<IpAddr>().unwrap()));
        for raw in ["::1", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1"] {
            assert!(is_private_ip(&raw.parse::<IpAddr>().unwrap()), "{raw}");
        }
        assert!(!is_private_ip(&"2606:4700:4700::1111".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn redacts_token_shapes() {
        let cases = [
            ("Bearer sk-abcdefghijklmnopqrstuvwxyz", "Bearer [redacted]"),
            ("Authorization: Bearer abcdef123456", "Authorization: [redacted]"),
            ("x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "x-api-key: [redacted]"),
            ("key=supersecretvalue1234567890", "key=[redacted]"),
            ("?access_token=abcdefghijklmnop&x=1", "?access_token=[redacted]&x=1"),
            ("payload ghp_abcdefghijklmnopqrstuvwxyz0123456789 end", "payload [redacted] end"),
            ("hex 0123456789abcdef0123456789abcdef end", "hex [redacted] end"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "input: {input}");
        }
    }

    #[test]
    fn redacts_a_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz123456";
        assert_eq!(redact(&format!("token {jwt}")), "token [redacted]");
    }

    #[test]
    fn redacts_long_base64_and_leaves_short_text_alone() {
        let b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVogSklLTU5PUFFSU1RVVldYWVo=";
        assert_eq!(redact(&format!("blob {b64}")), "blob [redacted]");
        assert_eq!(redact("Usage is 47% used - resets in 3h"), "Usage is 47% used - resets in 3h");
    }

    #[test]
    fn redact_with_removes_literal_stored_secrets() {
        let secrets = vec!["hunter2-do-not-leak".to_string(), "a-longer-secret-value-12345".to_string()];
        let text = "error from a-longer-secret-value-12345 and hunter2-do-not-leak (status 500)";
        let out = redact_with(text, &secrets);
        assert!(!out.contains("hunter2-do-not-leak"));
        assert!(!out.contains("a-longer-secret-value-12345"));
        assert!(out.contains("[redacted]"));
        assert!(out.contains("status 500"));
    }
}
