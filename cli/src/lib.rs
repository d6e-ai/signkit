pub mod args;
pub mod client;
pub mod commands;
pub mod config;
pub mod error;
pub mod io;
pub mod output;
pub mod types;
pub mod validation;

use args::{Cli, Command, RecipientSubcommand};
use client::SignKitClient;
use config::resolve_config;
use error::{CliError, ExitCode};
use output::print_problem;

/// Executes the SignKit CLI and returns the appropriate ExitCode.
/// Preserves RFC 9457 error documents to stderr on failure.
pub async fn run_cli(cli: Cli) -> ExitCode {
    let raw = cli.raw;
    let pretty = cli.pretty;

    if let Command::Envelopes(ref args) = cli.command {
        if commands::envelopes::is_offline(&args.subcommand) {
            let result = commands::envelopes::execute_offline(&args.subcommand, raw, pretty);
            return match result {
                Ok(()) => ExitCode::Success,
                Err(err) => {
                    let exit_code = err.exit_code();
                    let problem = err.to_problem_detail("cli://signkit/validation");
                    print_problem(&problem, pretty);
                    exit_code
                }
            };
        }
    }

    if let Command::Recipient(ref args) = cli.command {
        if commands::recipient::is_offline(&args.subcommand) {
            let result = commands::recipient::execute_offline(&args.subcommand, raw, pretty);
            return match result {
                Ok(()) => ExitCode::Success,
                Err(err) => {
                    let exit_code = err.exit_code();
                    let problem = err.to_problem_detail("cli://signkit/validation");
                    print_problem(&problem, pretty);
                    exit_code
                }
            };
        }
    }

    let stdin_conflict: Option<&str> = match &cli.command {
        Command::Recipient(_) if cli.api_key_stdin => Some(
            "Recipient commands cannot use --api-key-stdin; only the recipient capability grants this authority.",
        ),
        Command::Recipient(args)
            if cli.recipient_capability_stdin
                && match &args.subcommand {
                    RecipientSubcommand::Viewed(action)
                    | RecipientSubcommand::Approve(action)
                    | RecipientSubcommand::Decline(action) => action.file == "-",
                    RecipientSubcommand::Sign(action) => action.file == "-",
                    _ => false,
                } =>
        {
            Some("Use --file PATH for the action JSON when --recipient-capability-stdin consumes standard input.")
        }
        Command::Recipient(_) => None,
        _ if cli.recipient_capability_stdin => Some(
            "--recipient-capability-stdin is only valid for recipient commands.",
        ),
        _ => None,
    };
    if let Some(detail) = stdin_conflict {
        let error: CliError = CliError::usage(detail);
        let problem = error.to_problem_detail("cli://signkit/config");
        print_problem(&problem, pretty);
        return error.exit_code();
    }

    let config = match resolve_config(
        cli.base_url,
        cli.api_key_stdin,
        cli.recipient_capability_stdin,
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
        Command::Openapi => commands::openapi::execute(&client, raw, pretty).await,
        Command::Envelopes(args) => {
            commands::envelopes::execute(&client, args.subcommand, raw, pretty).await
        }
        Command::Recipient(args) => {
            commands::recipient::execute(&client, args.subcommand, raw, pretty).await
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
