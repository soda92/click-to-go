import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
	// 1. Register the "Smart" Definition Provider (The Bypass Logic)
	const defProvider = vscode.languages.registerDefinitionProvider(
		{ scheme: 'file', language: 'python' },
		new SmartRedirectDefinitionProvider()
	);

	// 2. Register the Link Provider (For clicking comments inside the file)
	const linkProvider = vscode.languages.registerDocumentLinkProvider(
		{ scheme: 'file', pattern: '**/*' },
		new FileLineLinkProvider()
	);

	// 3. Register the Jump Command (Helper for the link provider)
	const jumpCommand = vscode.commands.registerCommand('clicktogo.jump', async (filePath: string, line: number) => {
		const uri = vscode.Uri.file(filePath);
		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc);
			const position = new vscode.Position(line - 1, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		} catch (error) {
			vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
		}
	});

	context.subscriptions.push(defProvider, linkProvider, jumpCommand);
}

/**
 * Intercepts "Go to Definition". If Pylance points to a .pyi file with a magic comment,
 * this provider resolves that comment and offers the REAL file location.
 */
class SmartRedirectDefinitionProvider implements vscode.DefinitionProvider {
	private isFetching = false; // Recursion guard

	async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		// Prevent infinite loop when we call executeDefinitionProvider below
		if (this.isFetching) { return undefined; }

		try {
			this.isFetching = true;

			// 1. Ask Pylance (and others): "Where is the definition?"
			const results: any = await vscode.commands.executeCommand(
				'vscode.executeDefinitionProvider',
				document.uri,
				position
			);

			if (!results || !Array.isArray(results)) { return undefined; }

			const newLocations: vscode.Location[] = [];

			// 2. Inspect Pylance's answers
			for (const loc of results) {
				// We only care if the definition is in a .pyi file
				if (loc.uri.fsPath.endsWith('.pyi')) {
					const realLocation = await this.resolveRealLocation(loc);
					if (realLocation) {
						newLocations.push(realLocation);
					}
				}
			}

			return newLocations;
		} finally {
			this.isFetching = false;
		}
	}

	private async resolveRealLocation(location: vscode.Location): Promise<vscode.Location | undefined> {
		try {
			const doc = await vscode.workspace.openTextDocument(location.uri);
			const lineText = doc.lineAt(location.range.start.line).text;

			// Regex to capture "filename.py:123"
			const regex = /#\s*([./\w\-\\]+\.py):(\d+)/;
			const match = regex.exec(lineText);

			if (match) {
				const relativePath = match[1];
				const lineNumber = parseInt(match[2], 10);

				// FIX: Resolve path relative to the .pyi file's folder
				const currentFileDir = path.dirname(location.uri.fsPath);
				const absolutePath = path.resolve(currentFileDir, relativePath);

				const targetUri = vscode.Uri.file(absolutePath);
				const targetPos = new vscode.Position(lineNumber - 1, 0);
				return new vscode.Location(targetUri, targetPos);
			}
		} catch (e) {
			console.error(e);
		}
		return undefined;
	}
}

/**
 * (Previous logic) Makes the comments clickable inside the editor
 */
class FileLineLinkProvider implements vscode.DocumentLinkProvider {
	provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
		const links: vscode.DocumentLink[] = [];
		const text = document.getText();

		// Regex matches "file.py:123"
		const regex = /([./\w\-\\]+\.py):(\d+)/g;

		let match;
		while ((match = regex.exec(text)) !== null) {
			const matchText = match[0];
			const filePath = match[1];
			const lineNumber = parseInt(match[2], 10);

			const startPos = document.positionAt(match.index);
			const endPos = document.positionAt(match.index + matchText.length);
			const range = new vscode.Range(startPos, endPos);

			// FIX: Resolve path relative to the current file's folder
			const currentFileDir = path.dirname(document.uri.fsPath);
			const absolutePath = path.resolve(currentFileDir, filePath);

			const args = encodeURIComponent(JSON.stringify([absolutePath, lineNumber]));
			const link = new vscode.DocumentLink(range);
			link.target = vscode.Uri.parse(`command:clicktogo.jump?${args}`);
			links.push(link);
		}
		return links;
	}
}