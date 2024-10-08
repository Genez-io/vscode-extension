import * as vscode from 'vscode';
import * as http from 'http';
import * as url from 'url';
import * as path from 'path';
import * as yaml from 'yaml';
import { CompletionItem, CompletionItemKind } from 'vscode';
import { stat } from 'fs';
let statusBarItem: vscode.StatusBarItem;
let timeoutId:NodeJS.Timeout|undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "Genezio" is now active!');
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    setSignOutContext(context);

    // Register your deploy command
    let disposable = vscode.commands.registerCommand('genezio.deployProject', async () => {
        if (statusBarItem.text.includes('Deploying')) {
            const action = await vscode.window.showInformationMessage('Deployment already in progress. Do you want to abort the current deployment?', { modal: true }, "Yes");
            if (action === "Yes") {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                statusBarItem.text = '$(cloud-upload) Deploy App';
                vscode.window.showInformationMessage('Deployment aborted');
            }
            return;
        }
        statusBarItem.text = '$(sync~spin) Deploying...'; // Change icon to loading spinner
        vscode.window.showInformationMessage('Deploying project...');
        let token = await context.secrets.get('genezio-token');
        if (!token) {
            token = await startSignInFlow();
            if (token) {
                vscode.window.showInformationMessage('Signed in to Genezio');
                // Store the token securely, e.g., in VS Code's secret storage
                await context.secrets.store('genezio-token', token);
                setSignOutContext(context);
            } else {
                vscode.window.showErrorMessage('Sign in to Genezio failed');
                return;
            }
        }

        // Call Genezio API to deploy project
        try {
            await deployProject(context, token);
        } catch (error: any) {
            statusBarItem.text = '$(cloud-upload) Deploy App';
            vscode.window.showErrorMessage(`Deployment failed: ${error.message}`);
        }
    });
    context.subscriptions.push(disposable);

    disposable = vscode.commands.registerCommand('genezio.signOut', async () => {
        context.secrets.delete('genezio-token');
        setSignOutContext(context);
        vscode.window.showInformationMessage('Signed out from Genezio');
    });
    context.subscriptions.push(disposable);

    // Create a status bar item
    statusBarItem.text = '$(cloud-upload) Deploy App';
    statusBarItem.command = 'genezio.deployProject';
    statusBarItem.show();

    context.subscriptions.push(statusBarItem);
}

async function startSignInFlow(): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        // Start a local server to listen for the OAuth callback
        const server = http.createServer((req, res) => {
            const query = url.parse(req.url as string, true).query;
            if (query && query.token) {
                const token = query.token as string;

                // Close the server once we have the authorization code
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>You can close this window now.</h1>');
                server.close();

                resolve(token);
            } else {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<h1>Invalid response. Please try again.</h1>');
                server.close();
                reject(new Error('Failed to receive the authorization code.'));
            }
        }).listen(56912); // Use a port of your choice

        // Open the user's default browser with the sign in URL
        const signInUrl = 'https://app.genez.io/cli/login?redirect_url=http://localhost:56912';
        vscode.env.openExternal(vscode.Uri.parse(signInUrl));
    });
}

function checkIfBinary(fileContent: Uint8Array): boolean {
    const sampleSize = Math.min(512, fileContent.length);
    for (let i = 0; i < sampleSize; i++) {
        const byte = fileContent[i];
        // Check for non-text binary characters (0-31 range in ASCII, except for common text characters like tab, newline, carriage return)
        if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
            return true; // Likely a binary file
        }
    }
    return false; // Likely a text file
}

async function readAllFiles(): Promise<any> {
    let ret: { [key: string]:  any} = {};
    try {

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace is currently open.');
            return {};
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // List all files in the current workspace
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        
        // Iterate over the files and read their contents
        for (const file of files) {
            const fileContent = await vscode.workspace.fs.readFile(file);
            const relativePath = path.relative(workspaceRoot, file.fsPath);
            const isBinary = checkIfBinary(fileContent);

            if (isBinary) {
                ret[relativePath] = {
                    content: Buffer.from(fileContent).toString('base64'),
                    isBase64Encoded: true
                };
            } else {
                ret[relativePath] = {
                    content: new TextDecoder('utf-8').decode(fileContent),
                    isBase64Encoded: false
                };
            }

        }

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to list files: ${error.message}`);
    }
    return ret;
}

let oldReason = '';
async function checkDeployStatus(token: string, jobId: string, cnt: number) {
    if (cnt > 120) {
        statusBarItem.text = '$(cloud-upload) Deploy App';
        vscode.window.showErrorMessage("Deployment timed out");
        return;
    }

    let response: any;
    try {
        response = await fetch("https://build-system.genez.io/state/" + jobId, {
            "headers": {
            "accept": "application/json, text/plain, */*",
            "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
            "authorization": "Bearer " + token,
            "cache-control": "no-cache",
            "pragma": "no-cache",
            "priority": "u=1, i",
            "sec-ch-ua": "\"Chromium\";v=\"128\", \"Not;A=Brand\";v=\"24\", \"Google Chrome\";v=\"128\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"macOS\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "Referer": "https://app.genez.io/",
            "Referrer-Policy": "strict-origin-when-cross-origin"
            },
            "body": null,
            "method": "GET"
        });
    } catch (error: any) {
        statusBarItem.text = '$(cloud-upload) Deploy App';
        vscode.window.showErrorMessage("Failed to get build status: " + error.message);
        return;
    }

    let data: any;
    const responseText = await response.text();
    try {
        data = JSON.parse(responseText);
    } catch(error: any) {
        statusBarItem.text = '$(cloud-upload) Deploy App';
        vscode.window.showErrorMessage(responseText);
        return;
    }

    if (data.BuildStatus == "SUCCEEDED") {
        console.log(responseText);
        let url:string = '';
        if (data.ProjectDetails?.FrontendURLs && data.ProjectDetails.FrontendURLs.length > 0) {
            url = data.ProjectDetails.FrontendURLs[0];
        } else if(data.ProjectDetails?.BackendURLs && data.ProjectDetails.BackendURLs.length > 0) {
            url = data.ProjectDetails.BackendURLs[0].URL;
        }
        // add https:// if not present
        if (url && !url.startsWith("http")) {
            url = "https://" + url;
        }
        vscode.window.showInformationMessage("Deployment successful" + (url?" at "+url:""));
        statusBarItem.text = '$(cloud-upload) Deploy App';
        oldReason="";
        if (url) {
            const action = await vscode.window.showInformationMessage(`Your app was deployed at ${url}`, { modal: true }, "Open App");
            if (action === "Open App") {
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        }
        return;
    }

    const newReason = data.Transitions[data.Transitions.length - 1].Reason;
    if (newReason !== oldReason) {
        vscode.window.showInformationMessage(newReason);
        oldReason = newReason;
    }

    timeoutId = setTimeout(() => {checkDeployStatus(token, jobId, cnt+1);}, 1000);
}

function getProjectDetails(gy: any): any {
    if (gy?.content) {
        // get the project name from the genezio.yaml file
        try {
            const doc = yaml.parse(gy.content);
            if (doc && doc.name && doc.region) {
                return {
                    name: doc.name,
                    region: doc.region
                };
            }
        }catch(e) {
            console.error(e);
        }
    }
    // if the genezio.yaml file is not found or the project name is not specified, use the workspace folder name
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        // Get the first workspace folder path
        const workspacePath = workspaceFolders[0].uri.fsPath;

        // Extract just the folder name from the full path
        const folderName = path.basename(workspacePath);

        return folderName;
    }

    return {
        name: "genezio-project",
        region: "us-east-1"
    };
}


async function deployProject(context: any, token:string): Promise<void> {
    let files = await readAllFiles();
    const pd = getProjectDetails(files['genezio.yaml']);

    let body = {
        "token": token,
        "type":"s3",
        "args": {
            "projectName": pd.name,
            "region": pd.region,
            "stage":"prod",
            "stack":[],
            "code": files
        }
    };

    let response;
    try {
        response = await fetch("https://build-system.genez.io/deploy", {
            "headers": {
            "accept": "application/json, text/plain, */*",
            "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
            "cache-control": "no-cache",
            "content-type": "application/json",
            "pragma": "no-cache"
            },
            "body": JSON.stringify(body),
            "method": "POST"
        });
    } catch (error: any) {
        vscode.window.showErrorMessage("Failed calling the deploy endpoint: " + error.message);
        return;
    }
    
    let jsonResponse: any;
    const responseText = await response.text();
    try {
        jsonResponse = JSON.parse(responseText);
    } catch (error: any) {
        vscode.window.showErrorMessage(responseText);
        if (responseText.includes("401")) {
            context.secrets.delete('genezio-token');
            setSignOutContext(context);
        }
        return;
    }
    checkDeployStatus(token, jsonResponse.jobID, 1);
}

async function setSignOutContext(context: vscode.ExtensionContext) {
    const token = await context.secrets.get('genezio-token');
    vscode.commands.executeCommand('setContext', 'genezio.signedIn', !!token);
}

export function deactivate() {}
