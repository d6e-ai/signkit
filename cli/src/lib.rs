pub mod args;
pub mod client;
pub mod commands;
pub mod config;
pub mod error;
pub mod output;
pub mod types;

use args::{Cli, Command};
use client::SignKitClient;
use config::resolve_config;
use error::ExitCode;
use output::print_problem;

/// Executes the SignKit CLI and returns the appropriate ExitCode.
/// Preserves RFC 9457 error documents to stderr on failure.
pub async fn run_cli(cli: Cli) -> ExitCode {
    let raw = cli.raw;
    let pretty = cli.pretty;

    let config = match resolve_config(
        cli.base_url,
        cli.org,
        cli.api_key_stdin,
        cli.config.as_deref(),
        cli.timeout,
    ) {
        Ok(cfg) => cfg,
        Err(err) => {
            let exit_code = err.exit_code();
            let problem = err.to_problem_detail("cli://signkit/config");
            print_problem(&problem, pretty);
            return exit_code;
        }
    };

    let client = match SignKitClient::new(config) {
        Ok(client) => client,
        Err(err) => {
            let exit_code = err.exit_code();
            let problem = err.to_problem_detail("cli://signkit/client");
            print_problem(&problem, pretty);
            return exit_code;
        }
    };

    let result = match cli.command {
        Command::Capabilities => commands::capabilities::execute(&client, raw, pretty).await,
        Command::Envelopes(args) => {
            commands::envelopes::execute(&client, args.subcommand, raw, pretty).await
        }
    };

    match result {
        Ok(()) => ExitCode::Success,
        Err(err) => {
            let exit_code = err.exit_code();
            let problem = err.to_problem_detail("cli://signkit/command");
            print_problem(&problem, pretty);
            exit_code
        }
    }
}
