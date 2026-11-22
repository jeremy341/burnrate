fn main() {
    // Single-threaded here: safe point to publish BURNRATE_DATA for the installed layouts.
    burnrate_server::init_env();
    burnrate_server::run();
}
