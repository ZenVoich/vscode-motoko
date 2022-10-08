import { execSync } from 'child_process';
import * as glob from 'fast-glob';
import { existsSync, readFileSync } from 'fs';
import mo from 'motoko';
import * as baseLibrary from 'motoko/packages/latest/base.json';
import { join } from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    CodeAction,
    CodeActionKind,
    CompletionList,
    createConnection,
    Diagnostic,
    DiagnosticSeverity,
    FileChangeType,
    InitializeResult,
    Location,
    Position,
    ProposedFeatures,
    SignatureHelp,
    TextDocumentPositionParams,
    TextDocuments,
    TextDocumentSyncKind,
    TextEdit,
    WorkspaceFolder,
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { watchGlob as virtualFilePattern } from '../common/watchConfig';
import DfxResolver from './dfx';
import ImportResolver from './imports';
import { getText, resolveFilePath, resolveVirtualPath } from './utils';

interface Settings {
    motoko: MotokoSettings;
}

interface MotokoSettings {
    hideWarningRegex: string;
    maxNumberOfProblems: number;
}

// Always ignore `node_modules/` (often used in frontend canisters)
const ignoreGlobs = ['**/node_modules/**/*'];

// const moFileSet = new Set();

// Set up import suggestions
const importResolver = new ImportResolver();
Object.keys(baseLibrary.files).forEach((path) => {
    if (path.endsWith('.mo')) {
        path = path.slice(0, -'.mo'.length);
        const name = /([a-zA-Z0-9_]+)$/.exec(path)?.[1];
        if (name) {
            importResolver.set(name, `mo:base/${path}`);
        }
    }
});

// const astResolver = new AstResolver();

function getVesselArgs():
    | { workspaceFolder: WorkspaceFolder; args: string[] }
    | undefined {
    try {
        for (const folder of workspaceFolders || []) {
            const uri = folder.uri;
            if (!uri) {
                continue;
            }
            const ws = resolveFilePath(uri);
            if (
                !existsSync(join(ws, 'vessel.dhall')) &&
                !existsSync(join(ws, 'vessel.json'))
            ) {
                continue;
            }
            const flags = execSync('vessel sources', {
                cwd: ws,
            }).toString('utf8');
            return {
                workspaceFolder: folder,
                args: flags.split(' '),
            };
        }
    } catch (err) {
        console.warn(err);
    }
    return;
}

async function loadPackages() {
    mo.clearPackages();

    try {
        // Load default base library
        mo.loadPackage(baseLibrary);
    } catch (err) {
        console.error(`Error while loading base library: ${err}`);
    }

    const vesselArgs = getVesselArgs();
    if (vesselArgs) {
        const { workspaceFolder, args } = vesselArgs;
        // Load packages from Vessel
        let nextArg;
        while ((nextArg = args.shift())) {
            if (nextArg === '--package') {
                const name = args.shift()!;
                const path = resolveVirtualPath(
                    workspaceFolder.uri,
                    args.shift()!,
                );
                console.log('Package:', name, '->', path);
                mo.usePackage(name, path);
            }
        }
    }

    notifyDfxChange();
}

let dfxChangeTimeout: ReturnType<typeof setTimeout>;
function notifyDfxChange() {
    clearTimeout(dfxChangeTimeout);
    setTimeout(async () => {
        const dfxResolver = new DfxResolver(() => {
            if (!workspaceFolders?.length) {
                return null;
            }
            const folder = workspaceFolders[0];
            // for (const folder of workspaceFolders) {
            const basePath = resolveFilePath(folder.uri);
            const dfxPath = join(basePath, 'dfx.json');
            if (existsSync(dfxPath)) {
                return dfxPath;
            }
            return null;
            // }
        });

        try {
            const projectDir = await dfxResolver.getProjectDirectory();
            const dfxConfig = await dfxResolver.getConfig();
            if (projectDir && dfxConfig) {
                if (dfxConfig.canisters) {
                    try {
                        const idsPath = join(
                            projectDir,
                            '.dfx/local/canister_ids.json',
                        );
                        if (existsSync(idsPath)) {
                            const canisterIds = JSON.parse(
                                readFileSync(idsPath, 'utf8'),
                            );
                            const aliases: Record<string, string> = {};
                            Object.entries(canisterIds).forEach(
                                ([name, ids]: [string, any]) => {
                                    const keys = Object.keys(ids);
                                    // Choose the only principal (or 'local' if multiple are defined)
                                    const key =
                                        keys.length === 1 ? keys[0] : 'local';
                                    if (key && key in ids) {
                                        aliases[name] = ids[key];
                                    }
                                },
                            );
                            const path = join(projectDir, `.dfx/local/lsp`);
                            const uri = URI.file(path).toString();
                            mo.setAliases(resolveVirtualPath(uri), aliases);
                        }
                    } catch (err) {
                        console.error(
                            `Error while resolving canister aliases: ${err}`,
                        );
                    }

                    for (const [_name, _canister] of Object.entries(
                        dfxConfig.canisters,
                    )) {
                        // try {
                        //     if (
                        //         (!canister.type || canister.type === 'motoko') &&
                        //         canister.main
                        //     ) {
                        //         const uri = URI.file(
                        //             dirname(join(projectDir, canister.main)),
                        //         ).toString();
                        //         mo.usePackage(
                        //             `canister:${name}`,
                        //             resolveVirtualPath(uri),
                        //         );
                        //     }
                        // } catch (err) {
                        //     console.error(
                        //         `Error while adding sibling Motoko canister '${name}' as a package: ${err}`,
                        //     );
                        // }
                    }
                }
            }
        } catch (err) {
            console.error('Error while loading dfx.json:');
            console.error(err);
        }

        checkWorkspace();
    }, 100);
}

// Create a connection for the language server
const connection = createConnection(ProposedFeatures.all);

const forwardMessage =
    (send: (message: string) => void) =>
    (...args: any[]): void => {
        const toString = (value: any) => {
            try {
                return typeof value === 'string'
                    ? value
                    : value instanceof Promise
                    ? `<Promise>`
                    : JSON.stringify(value);
            } catch (err) {
                return `<${err}>`;
            }
        };
        send(args.map(toString).join(' '));
    };

console.log = forwardMessage(connection.console.log.bind(connection.console));
console.warn = forwardMessage(connection.console.warn.bind(connection.console));
console.error = forwardMessage(
    connection.console.error.bind(connection.console),
);

export const documents = new TextDocuments(TextDocument);

let settings: MotokoSettings | undefined;
let workspaceFolders: WorkspaceFolder[] | undefined;

connection.onInitialize((event): InitializeResult => {
    workspaceFolders = event.workspaceFolders || undefined;

    const result: InitializeResult = {
        capabilities: {
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['.'],
                // allCommitCharacters: ['.'],
            },
            // definitionProvider: true,
            codeActionProvider: true,
            // declarationProvider: true,
            // hoverProvider: true,
            // diagnosticProvider: {
            //     documentSelector: ['motoko'],
            //     interFileDependencies: true,
            //     workspaceDiagnostics: false,
            // },
            textDocumentSync: TextDocumentSyncKind.Full,
            workspace: {
                workspaceFolders: {
                    supported: !!workspaceFolders,
                },
            },
        },
    };
    return result;
});

connection.onInitialized(() => {
    connection.workspace?.onDidChangeWorkspaceFolders((event) => {
        const folders = workspaceFolders;
        if (!folders) {
            return;
        }
        event.removed.forEach((workspaceFolder) => {
            const index = folders.findIndex(
                (folder) => folder.uri === workspaceFolder.uri,
            );
            if (index !== -1) {
                folders.splice(index, 1);
            }
        });
        event.added.forEach((workspaceFolder) => {
            folders.push(workspaceFolder);
        });

        notifyWorkspace();
    });

    notifyWorkspace();

    // loadPrimaryDfxConfig();

    loadPackages().catch((err) => {
        console.error('Error while loading Motoko packages:');
        console.error(err);
    });
});

connection.onDidChangeWatchedFiles((event) => {
    event.changes.forEach((change) => {
        try {
            if (change.type === FileChangeType.Deleted) {
                // moFileSet.delete(change.uri);
                const path = resolveVirtualPath(change.uri);
                mo.delete(path);
                connection.sendDiagnostics({
                    uri: change.uri,
                    diagnostics: [],
                });
            } else {
                // moFileSet.add(change.uri);
                notify(change.uri);
                // check(change.uri);
            }
            if (change.uri.endsWith('.did')) {
                notifyDfxChange();
            }
        } catch (err) {
            console.error(`Error while handling Motoko file change: ${err}`);
        }
    });

    // validateOpenDocuments();
    checkWorkspace();
});

connection.onDidChangeConfiguration((event) => {
    settings = (<Settings>event.settings).motoko;
    checkWorkspace();
    notifyDfxChange();
});

/**
 * Registers or updates all Motoko files in the current workspace.
 */
function notifyWorkspace() {
    if (!workspaceFolders) {
        return;
    }
    workspaceFolders.forEach((folder) => {
        const folderPath = resolveFilePath(folder.uri);
        glob.sync(virtualFilePattern, {
            cwd: folderPath,
            dot: true,
        }).forEach((relativePath) => {
            const path = join(folderPath, relativePath);
            try {
                const virtualPath = resolveVirtualPath(
                    folder.uri,
                    relativePath,
                );
                console.log('*', virtualPath);
                write(virtualPath, readFileSync(path, 'utf8'));
                // const uri = URI.file(
                //     resolveFilePath(folder.uri, relativePath),
                // );
                // moFileSet.add(uri);
            } catch (err) {
                console.error(`Error while adding Motoko file ${path}:`);
                console.error(err);
            }
        });
    });
}

let checkWorkspaceTimeout: ReturnType<typeof setTimeout>;
/**
 * Type-checks all Motoko files in the current workspace.
 */
function checkWorkspace() {
    clearTimeout(checkWorkspaceTimeout);
    checkWorkspaceTimeout = setTimeout(() => {
        console.log('Checking workspace');

        workspaceFolders?.forEach((folder) => {
            const folderPath = resolveFilePath(folder.uri);
            glob.sync('**/*.mo', {
                cwd: folderPath,
                dot: false, // exclude directories such as `.vessel`
                ignore: ignoreGlobs,
            }).forEach((relativePath) => {
                const path = join(folderPath, relativePath);
                try {
                    const file = URI.file(path).toString();
                    // notify(file);
                    check(file);
                } catch (err) {
                    console.error(`Error while checking Motoko file ${path}:`);
                    console.error(err);
                }
            });
        });

        // validateOpenDocuments();

        // loadPrimaryDfxConfig()
        //     .then((dfxConfig) => {
        //         if (!dfxConfig) {
        //             return;
        //         }
        //         console.log('dfx.json:', JSON.stringify(dfxConfig));
        //         Object.values(dfxConfig.canisters).forEach((canister) => {
        //             if (
        //                 (!canister.type || canister.type === 'motoko') &&
        //                 canister.main
        //             ) {
        //                 const folder = workspaceFolders![0]; // temp
        //                 const filePath = join(
        //                     resolveFilePath(folder.uri),
        //                     canister.main,
        //                 );
        //                 const uri = URI.file(filePath).toString();
        //                 validate(uri);
        //             }
        //         });
        //     })
        //     .catch((err) => console.error(`Error while loading dfx.json: ${err}`));
    }, 500);
}

// /**
//  * Validates all Motoko files which are currently open in the editor.
//  */
// function validateOpenDocuments() {
//     // TODO: validate all tabs
//     documents.all().forEach((document) => notify(document));
//     documents.all().forEach((document) => check(document));
// }

function validate(uri: string | TextDocument) {
    notify(uri);
    check(uri);
}

/**
 * Registers or updates the URI or document in the compiler's virtual file system.
 */
function notify(uri: string | TextDocument): boolean {
    try {
        const document = typeof uri === 'string' ? documents.get(uri) : uri;
        if (document) {
            const virtualPath = resolveVirtualPath(document.uri);
            write(virtualPath, document.getText());
        } else if (typeof uri === 'string') {
            const virtualPath = resolveVirtualPath(uri);
            const filePath = resolveFilePath(uri);
            write(virtualPath, readFileSync(filePath, 'utf8'));
        }
    } catch (err) {
        console.error(`Error while updating Motoko file: ${err}`);
    }
    return false;
}

/**
 * Generates errors and warnings for a document.
 */
function check(uri: string | TextDocument): boolean {
    // TODO: debounce
    try {
        const skipExtension = '.mo_';
        const resolvedUri = typeof uri === 'string' ? uri : uri?.uri;
        if (resolvedUri?.endsWith(skipExtension)) {
            connection.sendDiagnostics({
                uri: resolvedUri,
                diagnostics: [],
            });
            return false;
        }

        let virtualPath: string;
        const document = typeof uri === 'string' ? documents.get(uri) : uri;
        if (document) {
            // if (document.languageId !== 'motoko') {
            //     return false;
            // }
            virtualPath = resolveVirtualPath(document.uri);
        } else if (typeof uri === 'string') {
            virtualPath = resolveVirtualPath(uri);
        } else {
            return false;
        }

        console.log('~', virtualPath);
        let diagnostics = mo.check(virtualPath) as any as Diagnostic[];

        if (settings) {
            if (settings.maxNumberOfProblems > 0) {
                diagnostics = diagnostics.slice(
                    0,
                    settings.maxNumberOfProblems,
                );
            }
            if (settings.hideWarningRegex?.trim()) {
                diagnostics = diagnostics.filter(
                    ({ message, severity }) =>
                        severity === DiagnosticSeverity.Error ||
                        // @ts-ignore
                        !new RegExp(settings.hideWarningRegex).test(message),
                );
            }
        }
        const diagnosticMap: Record<string, Diagnostic[]> = {
            [virtualPath]: [], // Start with empty diagnostics for the main file
        };
        diagnostics.forEach((diagnostic) => {
            const key = diagnostic.source || virtualPath;
            if (!key.endsWith(skipExtension)) {
                (diagnosticMap[key] || (diagnosticMap[key] = [])).push({
                    ...diagnostic,
                    source: 'Motoko',
                });
            }
        });

        Object.entries(diagnosticMap).forEach(([path, diagnostics]) => {
            connection.sendDiagnostics({
                uri: URI.file(path).toString(),
                diagnostics: diagnostics,
            });
        });
        return true;
    } catch (err) {
        console.error(`Error while compiling Motoko file: ${err}`);
        connection.sendDiagnostics({
            uri: typeof uri === 'string' ? uri : uri.uri,
            diagnostics: [
                {
                    message: 'Unexpected error while compiling Motoko file.',
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 },
                    },
                },
            ],
        });
    }
    return false;
}

function write(virtualPath: string, content: string) {
    // if (virtualPath.endsWith('.mo')) {
    //     content = preprocessMotoko(content);
    // }
    mo.write(virtualPath, content);
}

connection.onCodeAction((event) => {
    const results: CodeAction[] = [];

    event.context?.diagnostics?.forEach((diagnostic) => {
        const uri = event.textDocument.uri;
        const name = /unbound variable ([a-zA-Z0-9_]+)/i.exec(
            diagnostic.message,
        )?.[1];
        if (name) {
            importResolver.getImportPaths(name, uri).forEach((path) => {
                // Add import suggestion
                results.push({
                    kind: CodeActionKind.QuickFix,
                    isPreferred: true,
                    title: `Import "${path}"`,
                    edit: {
                        changes: {
                            [uri]: [
                                TextEdit.insert(
                                    Position.create(0, 0),
                                    `import ${name} "${path}";\n`,
                                ),
                            ],
                        },
                    },
                });
            });
        }
    });
    return results;
});

connection.onCodeActionResolve((action) => {
    console.log('Code action resolve');

    console.log(action.data);

    return action;
});

connection.onSignatureHelp((): SignatureHelp | null => {
    return null;
});

connection.onCompletion((event) => {
    const { position } = event;
    const { uri } = event.textDocument;

    const list = CompletionList.create([], true);
    try {
        const text = getText(uri);
        const lines = text.split(/\r?\n/g);

        const match = /(\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(
            lines[position.line].substring(0, position.character),
        );
        if (match) {
            const [, dot, identStart] = match;
            if (!dot) {
                importResolver.getModuleEntries(uri).forEach(([name, path]) => {
                    if (name.startsWith(identStart)) {
                        list.items.push({
                            label: name,
                            detail: path,
                            insertText: name,
                            // additionalTextEdits: import
                        });
                    }
                });
            } else {
                // const preMatch = /(\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(
                //     lines[position.line].substring(
                //         0,
                //         position.character - dot.length - identStart.length,
                //     ),
                // );
                // if (preMatch) {
                //     const [, preDot, preIdent] = preMatch;
                //     if (!preDot) {
                //         importProvider
                //             .getFieldEntries()
                //             .forEach(([name, field, path]) => {
                //                 if (
                //                     name === preIdent &&
                //                     field.startsWith(identStart)
                //                 ) {
                //                     list.items.push({
                //                         label: name,
                //                         detail: path,
                //                         insertText: name,
                //                         // additionalTextEdits: import
                //                     });
                //                 }
                //             });
                //     }
                // }
            }
        }
    } catch (err) {
        console.error('Error during autocompletion:');
        console.error(err);
    }
    return list;
});

// connection.onCompletionResolve((item) => {
// });

connection.onDefinition(
    async (
        _handler: TextDocumentPositionParams,
    ): Promise<Location | Location[]> => {
        // const provider = new SolidityDefinitionProvider(
        //     rootPath,
        //     packageDefaultDependenciesDirectory,
        //     packageDefaultDependenciesContractsDirectory,
        //     remappings,
        // );
        // return provider.provideDefinition(
        //     documents.get(handler.textDocument.uri),
        //     handler.position,
        // );

        return [];
    },
);

let validatingTimeout: ReturnType<typeof setTimeout>;
documents.onDidChangeContent((event) => {
    const document = event.document;
    clearTimeout(validatingTimeout);
    validatingTimeout = setTimeout(() => validate(document), 300);
    validate(document);
});

// documents.onDidClose((event) =>
//     connection.sendDiagnostics({
//         diagnostics: [],
//         uri: event.document.uri,
//     }),
// );

documents.listen(connection);
connection.listen();
