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
    fn has_login(&self) -> bool {
        crate::readers::all().iter().find(|r| r.provider() == self.id).is_some_and(|r| r.dir().exists())
    }
    fn read(&self, _keys: &KeyStore) -> Vec<Value> {
        Vec::new()
    }
}
