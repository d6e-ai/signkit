use clap::Parser;
use signkit_cli::args::Cli;
use signkit_cli::run_cli;

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let exit_code = run_cli(cli).await;
    std::process::exit(exit_code.as_i32());
}
