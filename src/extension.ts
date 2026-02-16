import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({
  path: path.resolve(__dirname, '../.env')
});

import { generatePracticeQuestion } from './services/aiService';

export function activate(context: vscode.ExtensionContext) {

	console.log('CodeForgeX is now active!');

	const disposable = vscode.commands.registerCommand('codeforgex.startPractice', async () => {

		const editor = vscode.window.activeTextEditor;

		if (!editor) {
			vscode.window.showErrorMessage('No active file detected.');
			return;
		}

		const fileName = editor.document.fileName;
		const languageId = editor.document.languageId;
		const baseName = fileName.split('/').pop()?.toLowerCase() || '';

		let detectedTopic = 'General Programming';

		if (baseName.includes('binary') || baseName.includes('search')) {
			detectedTopic = 'Searching';
		} else if (baseName.includes('sort')) {
			detectedTopic = 'Sorting';
		} else if (baseName.includes('linked') || baseName.includes('list')) {
			detectedTopic = 'Linked List';
		}

		// Step 1: Show detected topic clearly
		const decision = await vscode.window.showInformationMessage(
			`Detected Topic: ${detectedTopic}`,
			{ modal: true },
			'Continue',
			'Change Topic'
		);

		if (!decision) {
			return;
		}

		// Step 2: If user wants to change topic
		if (decision === 'Change Topic') {
			const manualTopic = await vscode.window.showInputBox({
				prompt: 'Enter topic name manually'
			});

			if (manualTopic && manualTopic.trim() !== '') {
				detectedTopic = manualTopic.trim();
			}
		}

		vscode.window.showInformationMessage('Generating practice question...');

		const question = await generatePracticeQuestion(detectedTopic, languageId);

		const commentPrefix = languageId === 'python' ? '# ' : '// ';

		const formattedQuestion = question
			.split('\n')
			.map(line => commentPrefix + line)
			.join('\n');

		const firstLine = editor.document.lineAt(0).text;

		if (firstLine.includes('Mock Question')) {
			const action = await vscode.window.showInformationMessage(
				'A practice question already exists in this file.',
				'Replace',
				'Append',
				'Cancel'
			);

			if (action === 'Cancel' || !action) {
				return;
			}

			if (action === 'Replace') {
				const fullRange = new vscode.Range(
					editor.document.positionAt(0),
					editor.document.positionAt(editor.document.getText().length)
				);

				await editor.edit(editBuilder => {
					editBuilder.replace(fullRange, formattedQuestion + '\n\n');
				});

				return;
			}

			if (action === 'Append') {
				await editor.edit(editBuilder => {
					editBuilder.insert(
						new vscode.Position(editor.document.lineCount, 0),
						'\n\n' + formattedQuestion
					);
				});

				return;
			}
		} else {
			await editor.edit(editBuilder => {
				editBuilder.insert(
					new vscode.Position(0, 0),
					formattedQuestion + '\n\n'
				);
			});
		}

	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
