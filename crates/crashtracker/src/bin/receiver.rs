#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
fn main() -> anyhow::Result<()> {
    // TODO: remove this line when the receiver default provider is fixed
    rustls::crypto::aws_lc_rs::default_provider().install_default().unwrap();
    libdd_crashtracker::receiver_entry_point_stdin()
}
