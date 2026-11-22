use super::*;

/// Providers with no subscription-limit API: Burnrate shows their cost and tokens from the local
/// transcripts. Connected means their transcript folder exists on this computer.
pub struct LogsOnly {
    id: &'static str,
    label: &'static str,
    color: &'static str,
}

impl LogsOnly {
    pub fn new(id: &'static str, label: &'static str, color: &'static str) -> LogsOnly {
        LogsOnly { id, label, color }
    }
}

impl Provider for LogsOnly {
    fn id(&self) -> &'static str {
        self.id
    }
    fn label(&self) -> &'static str {
        self.label
    }
    fn color(&self) -> &'static str {
        self.color
    }
    fn auth(&self) -> Auth {
        Auth::LocalLogs
    }
    fn hint(&self) -> &'static str {
        "Cost and tokens appear here once you use it on this computer"
    }
    fn has_login(&self) -> bool {
        // A folder the user added in Settings is a real detection too, even when the agent's
        // default folder does not exist on this computer.
        crate::readers::sources::configured(self.id).iter().any(|dir| dir.is_dir())
            || crate::readers::all().iter().find(|r| r.provider() == self.id).is_some_and(|r| r.dir().exists())
    }
    /// Session count, last use and the folder they were measured from, when the reader can count
    /// them (Pi and Muse today; other local-log agents have readers with no countable session
    /// log, so they report nothing rather than a guess).
    fn local_stats(&self) -> Option<LocalLogStats> {
        crate::readers::others::local_log_stats(self.id)
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        Vec::new()
    }
}
