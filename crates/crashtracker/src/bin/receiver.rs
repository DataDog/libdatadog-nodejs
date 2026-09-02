#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
fn main() -> anyhow::Result<()> {
    libdd_crashtracker::receiver_entry_point_stdin()
}
