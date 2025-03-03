import * as cpp from 'child-process-promise';
import * as child_process from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as sarif from 'sarif';
import { SemVer } from 'semver';
import { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import * as tk from 'tree-kill';
import { promisify } from 'util';
import { CancellationToken, commands, Disposable, Uri } from 'vscode';

import { BQRSInfo, DecodedBqrsChunk } from './pure/bqrs-cli-types';
import { CliConfig } from './config';
import { DistributionProvider, FindDistributionResultKind } from './distribution';
import { assertNever, getErrorMessage, getErrorStack } from './pure/helpers-pure';
import { QueryMetadata, SortDirection } from './pure/interface-types';
import { Logger, ProgressReporter } from './logging';
import { CompilationMessage } from './pure/messages';
import { sarifParser } from './sarif-parser';
import { dbSchemeToLanguage, walkDirectory } from './helpers';

/**
 * The version of the SARIF format that we are using.
 */
const SARIF_FORMAT = 'sarifv2.1.0';

/**
 * The string used to specify CSV format.
 */
const CSV_FORMAT = 'csv';

/**
 * Flags to pass to all cli commands.
 */
const LOGGING_FLAGS = ['-v', '--log-to-stderr'];

/**
 * The expected output of `codeql resolve library-path`.
 */
export interface QuerySetup {
  libraryPath: string[];
  dbscheme: string;
  relativeName?: string;
  compilationCache?: string;
}

/**
 * The expected output of `codeql resolve queries --format bylanguage`.
 */
export interface QueryInfoByLanguage {
  // Using `unknown` as a placeholder. For now, the value is only ever an empty object.
  byLanguage: Record<string, Record<string, unknown>>;
  noDeclaredLanguage: Record<string, unknown>;
  multipleDeclaredLanguages: Record<string, unknown>;
}

/**
 * The expected output of `codeql resolve database`.
 */
export interface DbInfo {
  sourceLocationPrefix: string;
  columnKind: string;
  unicodeNewlines: boolean;
  sourceArchiveZip: string;
  sourceArchiveRoot: string;
  datasetFolder: string;
  logsFolder: string;
  languages: string[];
}

/**
 * The expected output of `codeql resolve upgrades`.
 */
export interface UpgradesInfo {
  scripts: string[];
  finalDbscheme: string;
  matchesTarget?: boolean;
}

/**
 * The expected output of `codeql resolve qlpacks`.
 */
export type QlpacksInfo = { [name: string]: string[] };

/**
 * The expected output of `codeql resolve languages`.
 */
export type LanguagesInfo = { [name: string]: string[] };

/** Information about an ML model, as resolved by `codeql resolve ml-models`. */
export type MlModelInfo = {
  checksum: string;
  path: string;
};

/** The expected output of `codeql resolve ml-models`. */
export type MlModelsInfo = { models: MlModelInfo[] };

/**
 * The expected output of `codeql resolve qlref`.
 */
export type QlrefInfo = { resolvedPath: string };

// `codeql bqrs interpret` requires both of these to be present or
// both absent.
export interface SourceInfo {
  sourceArchive: string;
  sourceLocationPrefix: string;
}

/**
 * The expected output of `codeql resolve tests`.
 */
export type ResolvedTests = string[];

/**
 * Options for `codeql test run`.
 */
export interface TestRunOptions {
  cancellationToken?: CancellationToken;
  logger?: Logger;
}

/**
 * Event fired by `codeql test run`.
 */
export interface TestCompleted {
  test: string;
  pass: boolean;
  messages: CompilationMessage[];
  compilationMs: number;
  evaluationMs: number;
  expected: string;
  diff: string[] | undefined;
  failureDescription?: string;
  failureStage?: string;
}

/**
 * Optional arguments for the `bqrsDecode` function
 */
interface BqrsDecodeOptions {
  /** How many results to get. */
  pageSize?: number;
  /** The 0-based index of the first result to get. */
  offset?: number;
  /** The entity names to retrieve from the bqrs file. Default is url, string */
  entities?: string[];
}

/**
 * This class manages a cli server started by `codeql execute cli-server` to
 * run commands without the overhead of starting a new java
 * virtual machine each time. This class also controls access to the server
 * by queueing the commands sent to it.
 */
export class CodeQLCliServer implements Disposable {


  /** The process for the cli server, or undefined if one doesn't exist yet */
  process?: child_process.ChildProcessWithoutNullStreams;
  /** Queue of future commands*/
  commandQueue: (() => void)[];
  /** Whether a command is running */
  commandInProcess: boolean;
  /**  A buffer with a single null byte. */
  nullBuffer: Buffer;

  /** Version of current cli, lazily computed by the `getVersion()` method */
  private _version: SemVer | undefined;

  /**
   * The languages supported by the current version of the CLI, computed by `getSupportedLanguages()`.
   */
  private _supportedLanguages: string[] | undefined;

  /** Path to current codeQL executable, or undefined if not running yet. */
  codeQlPath: string | undefined;

  cliConstraints = new CliVersionConstraint(this);

  /**
   * When set to true, ignore some modal popups and assume user has clicked "yes".
   */
  public quiet = false;

  constructor(
    private distributionProvider: DistributionProvider,
    private cliConfig: CliConfig,
    private logger: Logger
  ) {
    this.commandQueue = [];
    this.commandInProcess = false;
    this.nullBuffer = Buffer.alloc(1);
    if (this.distributionProvider.onDidChangeDistribution) {
      this.distributionProvider.onDidChangeDistribution(() => {
        this.restartCliServer();
        this._version = undefined;
        this._supportedLanguages = undefined;
      });
    }
    if (this.cliConfig.onDidChangeConfiguration) {
      this.cliConfig.onDidChangeConfiguration(() => {
        this.restartCliServer();
        this._version = undefined;
        this._supportedLanguages = undefined;
      });
    }
  }

  dispose(): void {
    this.killProcessIfRunning();
  }

  killProcessIfRunning(): void {
    if (this.process) {
      // Tell the Java CLI server process to shut down.
      void this.logger.log('Sending shutdown request');
      try {
        this.process.stdin.write(JSON.stringify(['shutdown']), 'utf8');
        this.process.stdin.write(this.nullBuffer);
        void this.logger.log('Sent shutdown request');
      } catch (e) {
        // We are probably fine here, the process has already closed stdin.
        void this.logger.log(`Shutdown request failed: process stdin may have already closed. The error was ${e}`);
        void this.logger.log('Stopping the process anyway.');
      }
      // Close the stdin and stdout streams.
      // This is important on Windows where the child process may not die cleanly.
      this.process.stdin.end();
      this.process.kill();
      this.process.stdout.destroy();
      this.process.stderr.destroy();
      this.process = undefined;

    }
  }

  /**
   * Restart the server when the current command terminates
   */
  private restartCliServer(): void {
    const callback = (): void => {
      try {
        this.killProcessIfRunning();
      } finally {
        this.runNext();
      }
    };

    // If the server is not running a command run this immediately
    // otherwise add to the front of the queue (as we want to run this after the next command()).
    if (this.commandInProcess) {
      this.commandQueue.unshift(callback);
    } else {
      callback();
    }

  }

  /**
   * Get the path to the CodeQL CLI distribution, or throw an exception if not found.
   */
  private async getCodeQlPath(): Promise<string> {
    const codeqlPath = await this.distributionProvider.getCodeQlPathWithoutVersionCheck();
    if (!codeqlPath) {
      throw new Error('Failed to find CodeQL distribution.');
    }
    return codeqlPath;
  }

  /**
   * Launch the cli server
   */
  private async launchProcess(): Promise<child_process.ChildProcessWithoutNullStreams> {
    const codeQlPath = await this.getCodeQlPath();
    const args = [];
    if (shouldDebugCliServer()) {
      args.push('-J=-agentlib:jdwp=transport=dt_socket,address=localhost:9012,server=n,suspend=y,quiet=y');
    }

    return await spawnServer(
      codeQlPath,
      'CodeQL CLI Server',
      ['execute', 'cli-server'],
      args,
      this.logger,
      _data => { /**/ }
    );
  }

  private async runCodeQlCliInternal(command: string[], commandArgs: string[], description: string): Promise<string> {
    const stderrBuffers: Buffer[] = [];
    if (this.commandInProcess) {
      throw new Error('runCodeQlCliInternal called while cli was running');
    }
    this.commandInProcess = true;
    try {
      //Launch the process if it doesn't exist
      if (!this.process) {
        this.process = await this.launchProcess();
      }
      // Grab the process so that typescript know that it is always defined.
      const process = this.process;
      // The array of fragments of stdout
      const stdoutBuffers: Buffer[] = [];

      // Compute the full args array
      const args = command.concat(LOGGING_FLAGS).concat(commandArgs);
      const argsString = args.join(' ');
      void this.logger.log(`${description} using CodeQL CLI: ${argsString}...`);
      try {
        await new Promise<void>((resolve, reject) => {
          // Start listening to stdout
          process.stdout.addListener('data', (newData: Buffer) => {
            stdoutBuffers.push(newData);
            // If the buffer ends in '0' then exit.
            // We don't have to check the middle as no output will be written after the null until
            // the next command starts
            if (newData.length > 0 && newData.readUInt8(newData.length - 1) === 0) {
              resolve();
            }
          });
          // Listen to stderr
          process.stderr.addListener('data', (newData: Buffer) => {
            stderrBuffers.push(newData);
          });
          // Listen for process exit.
          process.addListener('close', (code) => reject(code));
          // Write the command followed by a null terminator.
          process.stdin.write(JSON.stringify(args), 'utf8');
          process.stdin.write(this.nullBuffer);
        });
        // Join all the data together
        const fullBuffer = Buffer.concat(stdoutBuffers);
        // Make sure we remove the terminator;
        const data = fullBuffer.toString('utf8', 0, fullBuffer.length - 1);
        void this.logger.log('CLI command succeeded.');
        return data;
      } catch (err) {
        // Kill the process if it isn't already dead.
        this.killProcessIfRunning();
        // Report the error (if there is a stderr then use that otherwise just report the error cod or nodejs error)
        const newError =
          stderrBuffers.length == 0
            ? new Error(`${description} failed: ${err}`)
            : new Error(`${description} failed: ${Buffer.concat(stderrBuffers).toString('utf8')}`);
        newError.stack += getErrorStack(err);
        throw newError;
      } finally {
        void this.logger.log(Buffer.concat(stderrBuffers).toString('utf8'));
        // Remove the listeners we set up.
        process.stdout.removeAllListeners('data');
        process.stderr.removeAllListeners('data');
        process.removeAllListeners('close');
      }
    } finally {
      this.commandInProcess = false;
      // start running the next command immediately
      this.runNext();
    }
  }

  /**
   * Run the next command in the queue
   */
  private runNext(): void {
    const callback = this.commandQueue.shift();
    if (callback) {
      callback();
    }
  }

  /**
   * Runs an asynchronous CodeQL CLI command without invoking the CLI server, returning any events
   * fired by the command as an asynchronous generator.
   *
   * @param command The `codeql` command to be run, provided as an array of command/subcommand names.
   * @param commandArgs The arguments to pass to the `codeql` command.
   * @param cancellationToken CancellationToken to terminate the test process.
   * @param logger Logger to write text output from the command.
   * @returns The sequence of async events produced by the command.
   */
  private async* runAsyncCodeQlCliCommandInternal(
    command: string[],
    commandArgs: string[],
    cancellationToken?: CancellationToken,
    logger?: Logger
  ): AsyncGenerator<string, void, unknown> {
    // Add format argument first, in case commandArgs contains positional parameters.
    const args = [
      ...command,
      '--format', 'jsonz',
      ...commandArgs
    ];

    // Spawn the CodeQL process
    const codeqlPath = await this.getCodeQlPath();
    const childPromise = cpp.spawn(codeqlPath, args);
    const child = childPromise.childProcess;

    let cancellationRegistration: Disposable | undefined = undefined;
    try {
      if (cancellationToken !== undefined) {
        cancellationRegistration = cancellationToken.onCancellationRequested(_e => {
          tk(child.pid || 0);
        });
      }
      if (logger !== undefined) {
        // The human-readable output goes to stderr.
        void logStream(child.stderr!, logger);
      }

      for await (const event of await splitStreamAtSeparators(child.stdout!, ['\0'])) {
        yield event;
      }

      await childPromise;
    }
    finally {
      if (cancellationRegistration !== undefined) {
        cancellationRegistration.dispose();
      }
    }
  }

  /**
   * Runs an asynchronous CodeQL CLI command without invoking the CLI server, returning any events
   * fired by the command as an asynchronous generator.
   *
   * @param command The `codeql` command to be run, provided as an array of command/subcommand names.
   * @param commandArgs The arguments to pass to the `codeql` command.
   * @param description Description of the action being run, to be shown in log and error messages.
   * @param cancellationToken CancellationToken to terminate the test process.
   * @param logger Logger to write text output from the command.
   * @returns The sequence of async events produced by the command.
   */
  public async* runAsyncCodeQlCliCommand<EventType>(
    command: string[],
    commandArgs: string[],
    description: string,
    cancellationToken?: CancellationToken,
    logger?: Logger
  ): AsyncGenerator<EventType, void, unknown> {
    for await (const event of await this.runAsyncCodeQlCliCommandInternal(command, commandArgs,
      cancellationToken, logger)) {
      try {
        yield JSON.parse(event) as EventType;
      } catch (err) {
        throw new Error(`Parsing output of ${description} failed: ${(err as any).stderr || getErrorMessage(err)}`);
      }
    }
  }

  /**
   * Runs a CodeQL CLI command on the server, returning the output as a string.
   * @param command The `codeql` command to be run, provided as an array of command/subcommand names.
   * @param commandArgs The arguments to pass to the `codeql` command.
   * @param description Description of the action being run, to be shown in log and error messages.
   * @param progressReporter Used to output progress messages, e.g. to the status bar.
   * @returns The contents of the command's stdout, if the command succeeded.
   */
  runCodeQlCliCommand(command: string[], commandArgs: string[], description: string, progressReporter?: ProgressReporter): Promise<string> {
    if (progressReporter) {
      progressReporter.report({ message: description });
    }

    return new Promise((resolve, reject) => {
      // Construct the command that actually does the work
      const callback = (): void => {
        try {
          this.runCodeQlCliInternal(command, commandArgs, description).then(resolve, reject);
        } catch (err) {
          reject(err);
        }
      };
      // If the server is not running a command, then run the given command immediately,
      // otherwise add to the queue
      if (this.commandInProcess) {
        this.commandQueue.push(callback);
      } else {
        callback();
      }
    });
  }

  /**
   * Runs a CodeQL CLI command, returning the output as JSON.
   * @param command The `codeql` command to be run, provided as an array of command/subcommand names.
   * @param commandArgs The arguments to pass to the `codeql` command.
   * @param description Description of the action being run, to be shown in log and error messages.
   * @param addFormat Whether or not to add commandline arguments to specify the format as JSON.
   * @param progressReporter Used to output progress messages, e.g. to the status bar.
   * @returns The contents of the command's stdout, if the command succeeded.
   */
  async runJsonCodeQlCliCommand<OutputType>(command: string[], commandArgs: string[], description: string, addFormat = true, progressReporter?: ProgressReporter): Promise<OutputType> {
    let args: string[] = [];
    if (addFormat) // Add format argument first, in case commandArgs contains positional parameters.
      args = args.concat(['--format', 'json']);
    args = args.concat(commandArgs);
    const result = await this.runCodeQlCliCommand(command, args, description, progressReporter);
    try {
      return JSON.parse(result) as OutputType;
    } catch (err) {
      throw new Error(`Parsing output of ${description} failed: ${(err as any).stderr || getErrorMessage(err)}`);
    }
  }

  /**
   * Resolve the library path and dbscheme for a query.
   * @param workspaces The current open workspaces
   * @param queryPath The path to the query
   */
  async resolveLibraryPath(workspaces: string[], queryPath: string): Promise<QuerySetup> {
    const subcommandArgs = [
      '--query', queryPath,
      ...this.getAdditionalPacksArg(workspaces)
    ];
    return await this.runJsonCodeQlCliCommand<QuerySetup>(['resolve', 'library-path'], subcommandArgs, 'Resolving library paths');
  }

  /**
   * Resolves the language for a query.
   * @param queryUri The URI of the query
   */
  async resolveQueryByLanguage(workspaces: string[], queryUri: Uri): Promise<QueryInfoByLanguage> {
    const subcommandArgs = [
      '--format', 'bylanguage',
      queryUri.fsPath,
      ...this.getAdditionalPacksArg(workspaces)
    ];
    return JSON.parse(await this.runCodeQlCliCommand(['resolve', 'queries'], subcommandArgs, 'Resolving query by language'));
  }

  /**
   * Finds all available QL tests in a given directory.
   * @param testPath Root of directory tree to search for tests.
   * @returns The list of tests that were found.
   */
  public async resolveTests(testPath: string): Promise<ResolvedTests> {
    const subcommandArgs = [
      testPath
    ];
    return await this.runJsonCodeQlCliCommand<ResolvedTests>(
      ['resolve', 'tests', '--strict-test-discovery'],
      subcommandArgs,
      'Resolving tests'
    );
  }

  public async resolveQlref(qlref: string): Promise<QlrefInfo> {
    const subcommandArgs = [
      qlref
    ];
    return await this.runJsonCodeQlCliCommand<QlrefInfo>(
      ['resolve', 'qlref'],
      subcommandArgs,
      'Resolving qlref',
      false
    );
  }

  /**
   * Issues an internal clear-cache command to the cli server. This
   * command is used to clear the qlpack cache of the server.
   *
   * This cache is generally cleared every 1s. This method is used
   * to force an early clearing of the cache.
   */
  public async clearCache(): Promise<void> {
    await this.runCodeQlCliCommand(['clear-cache'], [], 'Clearing qlpack cache');
  }

  /**
   * Runs QL tests.
   * @param testPaths Full paths of the tests to run.
   * @param workspaces Workspace paths to use as search paths for QL packs.
   * @param options Additional options.
   */
  public async* runTests(
    testPaths: string[], workspaces: string[], options: TestRunOptions
  ): AsyncGenerator<TestCompleted, void, unknown> {

    const subcommandArgs = this.cliConfig.additionalTestArguments.concat([
      ...this.getAdditionalPacksArg(workspaces),
      '--threads',
      this.cliConfig.numberTestThreads.toString(),
      ...testPaths
    ]);

    for await (const event of await this.runAsyncCodeQlCliCommand<TestCompleted>(['test', 'run'],
      subcommandArgs, 'Run CodeQL Tests', options.cancellationToken, options.logger)) {
      yield event;
    }
  }

  /**
   * Gets the metadata for a query.
   * @param queryPath The path to the query.
   */
  async resolveMetadata(queryPath: string): Promise<QueryMetadata> {
    return await this.runJsonCodeQlCliCommand<QueryMetadata>(['resolve', 'metadata'], [queryPath], 'Resolving query metadata');
  }

  /** Resolves the ML models that should be available when evaluating a query. */
  async resolveMlModels(additionalPacks: string[], queryPath: string): Promise<MlModelsInfo> {
    const args = await this.cliConstraints.supportsPreciseResolveMlModels()
      // use the dirname of the path so that we can handle query libraries
      ? [...this.getAdditionalPacksArg(additionalPacks), path.dirname(queryPath)]
      : this.getAdditionalPacksArg(additionalPacks);
    return await this.runJsonCodeQlCliCommand<MlModelsInfo>(
      ['resolve', 'ml-models'],
      args,
      'Resolving ML models',
      false
    );
  }

  /**
   * Gets the RAM setting for the query server.
   * @param queryMemoryMb The maximum amount of RAM to use, in MB.
   * Leave `undefined` for CodeQL to choose a limit based on the available system memory.
   * @param progressReporter The progress reporter to send progress information to.
   * @returns String arguments that can be passed to the CodeQL query server,
   * indicating how to split the given RAM limit between heap and off-heap memory.
   */
  async resolveRam(queryMemoryMb: number | undefined, progressReporter?: ProgressReporter): Promise<string[]> {
    const args: string[] = [];
    if (queryMemoryMb !== undefined) {
      args.push('--ram', queryMemoryMb.toString());
    }
    return await this.runJsonCodeQlCliCommand<string[]>(['resolve', 'ram'], args, 'Resolving RAM settings', true, progressReporter);
  }
  /**
   * Gets the headers (and optionally pagination info) of a bqrs.
   * @param bqrsPath The path to the bqrs.
   * @param pageSize The page size to precompute offsets into the binary file for.
   */
  async bqrsInfo(bqrsPath: string, pageSize?: number): Promise<BQRSInfo> {
    const subcommandArgs = (
      pageSize ? ['--paginate-rows', pageSize.toString()] : []
    ).concat(
      bqrsPath
    );
    return await this.runJsonCodeQlCliCommand<BQRSInfo>(['bqrs', 'info'], subcommandArgs, 'Reading bqrs header');
  }

  async databaseUnbundle(archivePath: string, target: string, name?: string): Promise<string> {
    const subcommandArgs = [];
    if (target) subcommandArgs.push('--target', target);
    if (name) subcommandArgs.push('--name', name);
    subcommandArgs.push(archivePath);

    return await this.runCodeQlCliCommand(['database', 'unbundle'], subcommandArgs, `Extracting ${archivePath} to directory ${target}`);
  }

  /**
   * Uses a .qhelp file to generate Query Help documentation in a specified format.
   * @param pathToQhelp The path to the .qhelp file
   * @param format The format in which the query help should be generated {@link https://codeql.github.com/docs/codeql-cli/manual/generate-query-help/#cmdoption-codeql-generate-query-help-format}
   * @param outputDirectory The output directory for the generated file
   */
  async generateQueryHelp(pathToQhelp: string, outputDirectory?: string): Promise<string> {
    const subcommandArgs = ['--format=markdown'];
    if (outputDirectory) subcommandArgs.push('--output', outputDirectory);
    subcommandArgs.push(pathToQhelp);

    return await this.runCodeQlCliCommand(['generate', 'query-help'], subcommandArgs, `Generating qhelp in markdown format at ${outputDirectory}`);
  }

  /**
  * Generate a summary of an evaluation log.
  * @param endSummaryPath The path to write only the end of query part of the human-readable summary to.
  * @param inputPath The path of an evaluation event log.
  * @param outputPath The path to write a human-readable summary of it to.
  */
  async generateLogSummary(
    inputPath: string,
    outputPath: string,
    endSummaryPath: string,
  ): Promise<string> {
    const subcommandArgs = [
      '--format=text',
      `--end-summary=${endSummaryPath}`,
      '--sourcemap',
      inputPath,
      outputPath
    ];
    return await this.runCodeQlCliCommand(['generate', 'log-summary'], subcommandArgs, 'Generating log summary');
  }

  /**
  * Generate a JSON summary of an evaluation log.
  * @param inputPath The path of an evaluation event log.
  * @param outputPath The path to write a JSON summary of it to.
  */
   async generateJsonLogSummary(
    inputPath: string,
    outputPath: string,
  ): Promise<string> {
    const subcommandArgs = [
      '--format=predicates',
      inputPath,
      outputPath
    ];
    return await this.runCodeQlCliCommand(['generate', 'log-summary'], subcommandArgs, 'Generating JSON log summary');
  }

  /**
  * Gets the results from a bqrs.
  * @param bqrsPath The path to the bqrs.
  * @param resultSet The result set to get.
  * @param options Optional BqrsDecodeOptions arguments
  */
  async bqrsDecode(
    bqrsPath: string,
    resultSet: string,
    { pageSize, offset, entities = ['url', 'string'] }: BqrsDecodeOptions = {}
  ): Promise<DecodedBqrsChunk> {

    const subcommandArgs = [
      `--entities=${entities.join(',')}`,
      '--result-set', resultSet,
    ].concat(
      pageSize ? ['--rows', pageSize.toString()] : []
    ).concat(
      offset ? ['--start-at', offset.toString()] : []
    ).concat([bqrsPath]);
    return await this.runJsonCodeQlCliCommand<DecodedBqrsChunk>(['bqrs', 'decode'], subcommandArgs, 'Reading bqrs data');
  }

  async runInterpretCommand(format: string, additonalArgs: string[], metadata: QueryMetadata, resultsPath: string, interpretedResultsPath: string, sourceInfo?: SourceInfo) {
    const args = [
      '--output', interpretedResultsPath,
      '--format', format,
      // Forward all of the query metadata.
      ...Object.entries(metadata).map(([key, value]) => `-t=${key}=${value}`)
    ].concat(additonalArgs);
    if (sourceInfo !== undefined) {
      args.push(
        '--source-archive', sourceInfo.sourceArchive,
        '--source-location-prefix', sourceInfo.sourceLocationPrefix
      );
    }

    args.push(
      '--threads',
      this.cliConfig.numberThreads.toString(),
    );

    args.push(
      '--max-paths',
      this.cliConfig.maxPaths.toString(),
    );

    args.push(resultsPath);
    await this.runCodeQlCliCommand(['bqrs', 'interpret'], args, 'Interpreting query results');
  }

  async interpretBqrsSarif(metadata: QueryMetadata, resultsPath: string, interpretedResultsPath: string, sourceInfo?: SourceInfo): Promise<sarif.Log> {
    const additionalArgs = [
      // TODO: This flag means that we don't group interpreted results
      // by primary location. We may want to revisit whether we call
      // interpretation with and without this flag, or do some
      // grouping client-side.
      '--no-group-results'
    ];

    await this.runInterpretCommand(SARIF_FORMAT, additionalArgs, metadata, resultsPath, interpretedResultsPath, sourceInfo);
    return await sarifParser(interpretedResultsPath);
  }

  // Warning: this function is untenable for large dot files,
  async readDotFiles(dir: string): Promise<string[]> {
    const dotFiles: Promise<string>[] = [];
    for await (const file of walkDirectory(dir)) {
      if (file.endsWith('.dot')) {
        dotFiles.push(fs.readFile(file, 'utf8'));
      }
    }
    return Promise.all(dotFiles);
  }

  async interpretBqrsGraph(metadata: QueryMetadata, resultsPath: string, interpretedResultsPath: string, sourceInfo?: SourceInfo): Promise<string[]> {
    const additionalArgs = sourceInfo
      ? ['--dot-location-url-format', 'file://' + sourceInfo.sourceLocationPrefix + '{path}:{start:line}:{start:column}:{end:line}:{end:column}']
      : [];

    await this.runInterpretCommand('dot', additionalArgs, metadata, resultsPath, interpretedResultsPath, sourceInfo);

    try {
      const dot = await this.readDotFiles(interpretedResultsPath);
      return dot;
    } catch (err) {
      throw new Error(`Reading output of interpretation failed: ${getErrorMessage(err)}`);
    }
  }

  async generateResultsCsv(metadata: QueryMetadata, resultsPath: string, csvPath: string, sourceInfo?: SourceInfo): Promise<void> {
    await this.runInterpretCommand(CSV_FORMAT, [], metadata, resultsPath, csvPath, sourceInfo);
  }

  async sortBqrs(resultsPath: string, sortedResultsPath: string, resultSet: string, sortKeys: number[], sortDirections: SortDirection[]): Promise<void> {
    const sortDirectionStrings = sortDirections.map(direction => {
      switch (direction) {
        case SortDirection.asc:
          return 'asc';
        case SortDirection.desc:
          return 'desc';
        default:
          return assertNever(direction);
      }
    });

    await this.runCodeQlCliCommand(['bqrs', 'decode'],
      [
        '--format=bqrs',
        `--result-set=${resultSet}`,
        `--output=${sortedResultsPath}`,
        `--sort-key=${sortKeys.join(',')}`,
        `--sort-direction=${sortDirectionStrings.join(',')}`,
        resultsPath
      ],
      'Sorting query results');
  }


  /**
   * Returns the `DbInfo` for a database.
   * @param databasePath Path to the CodeQL database to obtain information from.
   */
  resolveDatabase(databasePath: string): Promise<DbInfo> {
    return this.runJsonCodeQlCliCommand(['resolve', 'database'], [databasePath],
      'Resolving database');
  }

  /**
   * Gets information necessary for upgrading a database.
   * @param dbScheme the path to the dbscheme of the database to be upgraded.
   * @param searchPath A list of directories to search for upgrade scripts.
   * @param allowDowngradesIfPossible Whether we should try and include downgrades of we can.
   * @param targetDbScheme The dbscheme to try to upgrade to.
   * @returns A list of database upgrade script directories
   */
  async resolveUpgrades(dbScheme: string, searchPath: string[], allowDowngradesIfPossible: boolean, targetDbScheme?: string): Promise<UpgradesInfo> {
    const args = [...this.getAdditionalPacksArg(searchPath), '--dbscheme', dbScheme];
    if (targetDbScheme) {
      args.push('--target-dbscheme', targetDbScheme);
      if (allowDowngradesIfPossible && await this.cliConstraints.supportsDowngrades()) {
        args.push('--allow-downgrades');
      }
    }
    return await this.runJsonCodeQlCliCommand<UpgradesInfo>(
      ['resolve', 'upgrades'],
      args,
      'Resolving database upgrade scripts',
    );
  }

  /**
   * Gets information about available qlpacks
   * @param additionalPacks A list of directories to search for qlpacks before searching in `searchPath`.
   * @param searchPath A list of directories to search for packs not found in `additionalPacks`. If undefined,
   *   the default CLI search path is used.
   * @returns A dictionary mapping qlpack name to the directory it comes from
   */
  resolveQlpacks(additionalPacks: string[], searchPath?: string[]): Promise<QlpacksInfo> {
    const args = this.getAdditionalPacksArg(additionalPacks);
    if (searchPath?.length) {
      args.push('--search-path', path.join(...searchPath));
    }

    return this.runJsonCodeQlCliCommand<QlpacksInfo>(
      ['resolve', 'qlpacks'],
      args,
      'Resolving qlpack information',
    );
  }

  /**
   * Gets information about the available languages.
   * @returns A dictionary mapping language name to the directory it comes from
   */
  async resolveLanguages(): Promise<LanguagesInfo> {
    return await this.runJsonCodeQlCliCommand<LanguagesInfo>(['resolve', 'languages'], [], 'Resolving languages');
  }

  /**
   * Gets the list of available languages. Refines the result of `resolveLanguages()`, by excluding
   * extra things like "xml" and "properties".
   *
   * @returns An array of languages that are supported by the current version of the CodeQL CLI.
   */
  public async getSupportedLanguages(): Promise<string[]> {
    if (!this._supportedLanguages) {
      // Get the intersection of resolveLanguages with the list of hardcoded languages in dbSchemeToLanguage.
      const resolvedLanguages = Object.keys(await this.resolveLanguages());
      const hardcodedLanguages = Object.values(dbSchemeToLanguage);

      this._supportedLanguages = resolvedLanguages.filter(lang => hardcodedLanguages.includes(lang));
    }
    return this._supportedLanguages;
  }

  /**
   * Gets information about queries in a query suite.
   * @param suite The suite to resolve.
   * @param additionalPacks A list of directories to search for qlpacks before searching in `searchPath`.
   * @param searchPath A list of directories to search for packs not found in `additionalPacks`. If undefined,
   *   the default CLI search path is used.
   * @returns A list of query files found.
   */
  async resolveQueriesInSuite(suite: string, additionalPacks: string[], searchPath?: string[]): Promise<string[]> {
    const args = this.getAdditionalPacksArg(additionalPacks);
    if (searchPath !== undefined) {
      args.push('--search-path', path.join(...searchPath));
    }
    if (await this.cliConstraints.supportsAllowLibraryPacksInResolveQueries()) {
      // All of our usage of `codeql resolve queries` needs to handle library packs.
      args.push('--allow-library-packs');
    }
    args.push(suite);
    return this.runJsonCodeQlCliCommand<string[]>(
      ['resolve', 'queries'],
      args,
      'Resolving queries',
    );
  }

  /**
   * Downloads a specified pack.
   * @param packs The `<package-scope/name[@version]>` of the packs to download.
   */
  async packDownload(packs: string[]) {
    return this.runJsonCodeQlCliCommand(['pack', 'download'], packs, 'Downloading packs');
  }

  async packInstall(dir: string, forceUpdate = false) {
    const args = [dir];
    if (forceUpdate) {
      args.push('--mode', 'update');
    }
    return this.runJsonCodeQlCliCommand(['pack', 'install'], args, 'Installing pack dependencies');
  }

  async packBundle(dir: string, workspaceFolders: string[], outputPath: string, precompile = true): Promise<void> {
    const args = [
      '-o',
      outputPath,
      dir,
      ...this.getAdditionalPacksArg(workspaceFolders)
    ];
    if (!precompile && await this.cliConstraints.supportsNoPrecompile()) {
      args.push('--no-precompile');
    }

    return this.runJsonCodeQlCliCommand(['pack', 'bundle'], args, 'Bundling pack');
  }

  async packPacklist(dir: string, includeQueries: boolean): Promise<string[]> {
    const args = includeQueries ? [dir] : ['--no-include-queries', dir];
    // since 2.7.1, packlist returns an object with a "paths" property that is a list of packs.
    // previous versions return a list of packs.
    const results: { paths: string[] } | string[] = await this.runJsonCodeQlCliCommand(['pack', 'packlist'], args, 'Generating the pack list');

    // Once we no longer need to support 2.7.0 or earlier, we can remove this and assume all versions return an object.
    if ('paths' in results) {
      return results.paths;
    } else {
      return results;
    }
  }

  async generateDil(qloFile: string, outFile: string): Promise<void> {
    const extraArgs = await this.cliConstraints.supportsDecompileDil()
      ? ['--kind', 'dil', '-o', outFile, qloFile]
      : ['-o', outFile, qloFile];
    await this.runCodeQlCliCommand(
      ['query', 'decompile'],
      extraArgs,
      'Generating DIL',
    );
  }

  public async getVersion() {
    if (!this._version) {
      this._version = await this.refreshVersion();
      // this._version is only undefined upon config change, so we reset CLI-based context key only when necessary.
      await commands.executeCommand(
        'setContext', 'codeql.supportsEvalLog', await this.cliConstraints.supportsPerQueryEvalLog()
      );
    }
    return this._version;
  }

  private async refreshVersion() {
    const distribution = await this.distributionProvider.getDistribution();
    switch (distribution.kind) {
      case FindDistributionResultKind.CompatibleDistribution:
      // eslint-disable-next-line no-fallthrough
      case FindDistributionResultKind.IncompatibleDistribution:
        return distribution.version;

      default:
        // We should not get here because if no distributions are available, then
        // the cli class is never instantiated.
        throw new Error('No distribution found');
    }
  }

  private getAdditionalPacksArg(paths: string[]): string[] {
    return paths.length
      ? ['--additional-packs', paths.join(path.delimiter)]
      : [];
  }
}

/**
 * Spawns a child server process using the CodeQL CLI
 * and attaches listeners to it.
 *
 * @param config The configuration containing the path to the CLI.
 * @param name Name of the server being started, to be shown in log and error messages.
 * @param command The `codeql` command to be run, provided as an array of command/subcommand names.
 * @param commandArgs The arguments to pass to the `codeql` command.
 * @param logger Logger to write startup messages.
 * @param stderrListener Listener for log messages from the server's stderr stream.
 * @param stdoutListener Optional listener for messages from the server's stdout stream.
 * @param progressReporter Used to output progress messages, e.g. to the status bar.
 * @returns The started child process.
 */
export function spawnServer(
  codeqlPath: string,
  name: string,
  command: string[],
  commandArgs: string[],
  logger: Logger,
  stderrListener: (data: any) => void,
  stdoutListener?: (data: any) => void,
  progressReporter?: ProgressReporter
): child_process.ChildProcessWithoutNullStreams {
  // Enable verbose logging.
  const args = command.concat(commandArgs).concat(LOGGING_FLAGS);

  // Start the server process.
  const base = codeqlPath;
  const argsString = args.join(' ');
  if (progressReporter !== undefined) {
    progressReporter.report({ message: `Starting ${name}` });
  }
  void logger.log(`Starting ${name} using CodeQL CLI: ${base} ${argsString}`);
  const child = child_process.spawn(base, args);
  if (!child || !child.pid) {
    throw new Error(`Failed to start ${name} using command ${base} ${argsString}.`);
  }

  // Set up event listeners.
  child.on('close', (code) => logger.log(`Child process exited with code ${code}`));
  child.stderr!.on('data', stderrListener);
  if (stdoutListener !== undefined) {
    child.stdout!.on('data', stdoutListener);
  }

  if (progressReporter !== undefined) {
    progressReporter.report({ message: `Started ${name}` });
  }
  void logger.log(`${name} started on PID: ${child.pid}`);
  return child;
}

/**
 * Runs a CodeQL CLI command without invoking the CLI server, returning the output as a string.
 * @param codeQlPath The path to the CLI.
 * @param command The `codeql` command to be run, provided as an array of command/subcommand names.
 * @param commandArgs The arguments to pass to the `codeql` command.
 * @param description Description of the action being run, to be shown in log and error messages.
 * @param logger Logger to write command log messages, e.g. to an output channel.
 * @param progressReporter Used to output progress messages, e.g. to the status bar.
 * @returns The contents of the command's stdout, if the command succeeded.
 */
export async function runCodeQlCliCommand(
  codeQlPath: string,
  command: string[],
  commandArgs: string[],
  description: string,
  logger: Logger,
  progressReporter?: ProgressReporter
): Promise<string> {
  // Add logging arguments first, in case commandArgs contains positional parameters.
  const args = command.concat(LOGGING_FLAGS).concat(commandArgs);
  const argsString = args.join(' ');
  try {
    if (progressReporter !== undefined) {
      progressReporter.report({ message: description });
    }
    void logger.log(`${description} using CodeQL CLI: ${codeQlPath} ${argsString}...`);
    const result = await promisify(child_process.execFile)(codeQlPath, args);
    void logger.log(result.stderr);
    void logger.log('CLI command succeeded.');
    return result.stdout;
  } catch (err) {
    throw new Error(`${description} failed: ${(err as any).stderr || getErrorMessage(err)}`);
  }
}

/**
 * Buffer to hold state used when splitting a text stream into lines.
 */
class SplitBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private readonly maxSeparatorLength: number;
  private buffer = '';
  private searchIndex = 0;

  constructor(private readonly separators: readonly string[]) {
    this.maxSeparatorLength = separators.map(s => s.length).reduce((a, b) => Math.max(a, b), 0);
  }

  /**
   * Append new text data to the buffer.
   * @param chunk The chunk of data to append.
   */
  public addChunk(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
  }

  /**
   * Signal that the end of the input stream has been reached.
   */
  public end(): void {
    this.buffer += this.decoder.end();
    this.buffer += this.separators[0];  // Append a separator to the end to ensure the last line is returned.
  }

  /**
   * A version of startsWith that isn't overriden by a broken version of ms-python.
   *
   * The definition comes from
   * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/startsWith
   * which is CC0/public domain
   *
   * See https://github.com/github/vscode-codeql/issues/802 for more context as to why we need it.
   */
  private static startsWith(s: string, searchString: string, position: number): boolean {
    const pos = position > 0 ? position | 0 : 0;
    return s.substring(pos, pos + searchString.length) === searchString;
  }

  /**
   * Extract the next full line from the buffer, if one is available.
   * @returns The text of the next available full line (without the separator), or `undefined` if no
   * line is available.
   */
  public getNextLine(): string | undefined {
    while (this.searchIndex <= (this.buffer.length - this.maxSeparatorLength)) {
      for (const separator of this.separators) {
        if (SplitBuffer.startsWith(this.buffer, separator, this.searchIndex)) {
          const line = this.buffer.slice(0, this.searchIndex);
          this.buffer = this.buffer.slice(this.searchIndex + separator.length);
          this.searchIndex = 0;
          return line;
        }
      }
      this.searchIndex++;
    }

    return undefined;
  }
}

/**
 * Splits a text stream into lines based on a list of valid line separators.
 * @param stream The text stream to split. This stream will be fully consumed.
 * @param separators The list of strings that act as line separators.
 * @returns A sequence of lines (not including separators).
 */
async function* splitStreamAtSeparators(
  stream: Readable, separators: string[]
): AsyncGenerator<string, void, unknown> {

  const buffer = new SplitBuffer(separators);
  for await (const chunk of stream) {
    buffer.addChunk(chunk);
    let line: string | undefined;
    do {
      line = buffer.getNextLine();
      if (line !== undefined) {
        yield line;
      }
    } while (line !== undefined);
  }
  buffer.end();
  let line: string | undefined;
  do {
    line = buffer.getNextLine();
    if (line !== undefined) {
      yield line;
    }
  } while (line !== undefined);
}

/**
 *  Standard line endings for splitting human-readable text.
 */
const lineEndings = ['\r\n', '\r', '\n'];

/**
 * Log a text stream to a `Logger` interface.
 * @param stream The stream to log.
 * @param logger The logger that will consume the stream output.
 */
async function logStream(stream: Readable, logger: Logger): Promise<void> {
  for await (const line of await splitStreamAtSeparators(stream, lineEndings)) {
    // Await the result of log here in order to ensure the logs are written in the correct order.
    await logger.log(line);
  }
}


export function shouldDebugIdeServer() {
  return 'IDE_SERVER_JAVA_DEBUG' in process.env
    && process.env.IDE_SERVER_JAVA_DEBUG !== '0'
    && process.env.IDE_SERVER_JAVA_DEBUG?.toLocaleLowerCase() !== 'false';
}

export function shouldDebugQueryServer() {
  return 'QUERY_SERVER_JAVA_DEBUG' in process.env
    && process.env.QUERY_SERVER_JAVA_DEBUG !== '0'
    && process.env.QUERY_SERVER_JAVA_DEBUG?.toLocaleLowerCase() !== 'false';
}

export function shouldDebugCliServer() {
  return 'CLI_SERVER_JAVA_DEBUG' in process.env
    && process.env.CLI_SERVER_JAVA_DEBUG !== '0'
    && process.env.CLI_SERVER_JAVA_DEBUG?.toLocaleLowerCase() !== 'false';
}

export class CliVersionConstraint {

  /**
   * CLI version where --kind=DIL was introduced
   */
  public static CLI_VERSION_WITH_DECOMPILE_KIND_DIL = new SemVer('2.3.0');

  /**
   * CLI version where languages are exposed during a `codeql resolve database` command.
   */
  public static CLI_VERSION_WITH_LANGUAGE = new SemVer('2.4.1');

  /**
   * CLI version where `codeql resolve upgrades` supports
   * the `--allow-downgrades` flag
   */
  public static CLI_VERSION_WITH_DOWNGRADES = new SemVer('2.4.4');

  /**
   * CLI version where the `codeql resolve qlref` command is available.
   */
  public static CLI_VERSION_WITH_RESOLVE_QLREF = new SemVer('2.5.1');

  /**
   * CLI version where database registration was introduced
  */
  public static CLI_VERSION_WITH_DB_REGISTRATION = new SemVer('2.4.1');

  /**
   * CLI version where the `--allow-library-packs` option to `codeql resolve queries` was
   * introduced.
   */
  public static CLI_VERSION_WITH_ALLOW_LIBRARY_PACKS_IN_RESOLVE_QUERIES = new SemVer('2.6.1');

  /**
   * CLI version where the `database unbundle` subcommand was introduced.
   */
  public static CLI_VERSION_WITH_DATABASE_UNBUNDLE = new SemVer('2.6.0');

  /**
   * CLI version where the `--no-precompile` option for pack creation was introduced.
   */
  public static CLI_VERSION_WITH_NO_PRECOMPILE = new SemVer('2.7.1');

  /**
   * CLI version where remote queries (variant analysis) are supported.
   */
  public static CLI_VERSION_REMOTE_QUERIES = new SemVer('2.6.3');

  /**
   * CLI version where the `resolve ml-models` subcommand was introduced.
   */
  public static CLI_VERSION_WITH_RESOLVE_ML_MODELS = new SemVer('2.7.3');

  /**
   * CLI version where the `resolve ml-models` subcommand was enhanced to work with packaging.
   */
  public static CLI_VERSION_WITH_PRECISE_RESOLVE_ML_MODELS = new SemVer('2.10.0');

  /**
   * CLI version where the `--old-eval-stats` option to the query server was introduced.
   */
  public static CLI_VERSION_WITH_OLD_EVAL_STATS = new SemVer('2.7.4');

  /**
   * CLI version where packaging was introduced.
   */
  public static CLI_VERSION_WITH_PACKAGING = new SemVer('2.6.0');

  /**
   * CLI version where the `--evaluator-log` and related options to the query server were introduced,
   * on a per-query server basis.
   */
  public static CLI_VERSION_WITH_STRUCTURED_EVAL_LOG = new SemVer('2.8.2');

  /**
   * CLI version that supports rotating structured logs to produce one per query.
   *
   * Note that 2.8.4 supports generating the evaluation logs and summaries,
   * but 2.9.0 includes a new option to produce the end-of-query summary logs to
   * the query server console. For simplicity we gate all features behind 2.9.0,
   * but if a user is tied to the 2.8 release, we can enable evaluator logs
   * and summaries for them.
   */
  public static CLI_VERSION_WITH_PER_QUERY_EVAL_LOG = new SemVer('2.9.0');

  constructor(private readonly cli: CodeQLCliServer) {
    /**/
  }

  private async isVersionAtLeast(v: SemVer) {
    return (await this.cli.getVersion()).compare(v) >= 0;
  }

  public async supportsDecompileDil() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_DECOMPILE_KIND_DIL);
  }

  public async supportsLanguageName() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_LANGUAGE);
  }

  public async supportsDowngrades() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_DOWNGRADES);
  }

  public async supportsResolveQlref() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_RESOLVE_QLREF);
  }

  public async supportsAllowLibraryPacksInResolveQueries() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_ALLOW_LIBRARY_PACKS_IN_RESOLVE_QUERIES);
  }

  async supportsDatabaseRegistration() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_DB_REGISTRATION);
  }

  async supportsDatabaseUnbundle() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_DATABASE_UNBUNDLE);
  }

  async supportsNoPrecompile() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_NO_PRECOMPILE);
  }

  async supportsRemoteQueries() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_REMOTE_QUERIES);
  }

  async supportsResolveMlModels() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_RESOLVE_ML_MODELS);
  }

  async supportsPreciseResolveMlModels() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_PRECISE_RESOLVE_ML_MODELS);
  }

  async supportsOldEvalStats() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_OLD_EVAL_STATS);
  }

  async supportsPackaging() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_PACKAGING);
  }

  async supportsStructuredEvalLog() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_STRUCTURED_EVAL_LOG);
  }

  async supportsPerQueryEvalLog() {
    return this.isVersionAtLeast(CliVersionConstraint.CLI_VERSION_WITH_PER_QUERY_EVAL_LOG);
  }
}
