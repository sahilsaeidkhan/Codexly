import * as vscode from 'vscode';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PracticeTimer } from './services/timerService';
import { runActiveFile } from './services/runService';
import { saveToken, getToken, deleteToken, isLoggedIn } from './services/authService';
import { sendPracticeData } from './services/apiService';

dotenv.config({
	path: path.resolve(__dirname, '../.env')
});

import { generatePracticeQuestion } from './services/aiService';
import { evaluateCode, explainCode, explainSelection } from './services/geminiService';

let storedHint: string | null = null;
let storedSolution: string | null = null;
let storedExplanation: string | null = null;

// Feature 1: tracks whether question came from user-written text (not AI-generated)
let isUserWrittenQuestion = false;

// Feature 2: Selection explanation — snapshot-based, supports multiple explains.
// selectionFileSnapshot: full file content saved at the moment of FIRST explain.
//   Used by "Remove Selection Explanation" to restore everything at once.
// selectionExplainedBlocks: each explained block text, used to detect manual deletion.
// hasSelectionExplanationFlag: true when at least one explain has been inserted.
let selectionFileSnapshot: string | null = null;
let selectionExplainedBlocks: string[] = [];
let hasSelectionExplanationFlag = false;

// State flags for context management
let hasQuestionFlag = false;
let solutionVisibleFlag = false;
let hasExplanationFlag = false;
let hintVisibleFlag = false;
let evaluationVisibleFlag = false;
let practiceTimer: PracticeTimer;
let timerStatusBar: vscode.StatusBarItem;
let timerStarted = false;

// Guard flag: set TRUE before any programmatic editor.edit() or
// runActiveFile() call so the onDidChangeTextDocument listener
// ignores those events and never accidentally starts the timer.
let isExtensionEditing = false;

// ─────────────────────────────────────────────────────────────
// PHASE 2: Practice session tracking
// These are reset on every new question generation so each
// practice session is tracked independently.
// ─────────────────────────────────────────────────────────────
let hintsUsed = 0;
let solutionViewed = false;

// ─────────────────────────────────────────────────────────────
// FIX 2 & 3: detectManualQuestion
// Detects common coding question patterns for manually pasted
// questions. Used in onDidChangeTextDocument so the timer starts
// correctly even when the user pastes their own question without
// going through AI generation. Also fixes Problem 3 because once
// hasQuestionFlag is set, buildAvailableActions() works identically
// for manual and AI-generated flows.
// ─────────────────────────────────────────────────────────────
function detectManualQuestion(text: string): boolean {
	if (text.includes('Question (')) return true;
	const patterns = [
		/write\s+a\s+function/i,
		/write\s+a\s+program/i,
		/implement\s+a/i,
		/implement\s+the/i,
		/create\s+a\s+function/i,
		/create\s+a\s+program/i,
		/given\s+an?\s+array/i,
		/given\s+a\s+string/i,
		/given\s+a\s+list/i,
		/given\s+a\s+number/i,
		/find\s+the\s+/i,
		/return\s+the\s+/i,
		/design\s+a\s+/i,
		/you\s+are\s+given/i,
		/your\s+task\s+is/i,
		/write\s+an?\s+algorithm/i,
		/solve\s+the\s+following/i,
		/complete\s+the\s+function/i,
	];
	return patterns.some(p => p.test(text));
}

export function activate(context: vscode.ExtensionContext) {
	// Initialize context keys
	vscode.commands.executeCommand('setContext', 'codeforgex.hasQuestion', false);
	vscode.commands.executeCommand('setContext', 'codeforgex.solutionVisible', false);
	vscode.commands.executeCommand('setContext', 'codeforgex.hasExplanation', false);
	vscode.commands.executeCommand('setContext', 'codeforgex.hintVisible', false);
	vscode.commands.executeCommand('setContext', 'codeforgex.evaluationVisible', false);
	console.log('CodeForgeX is now active!');

	// ─────────────────────────────────────────────────────────────
	// PHASE 3: Auto-login persistence check on activation.
	// If a token is already stored, user is considered logged in.
	// No server validation — validation happens on first API call.
	// ─────────────────────────────────────────────────────────────
	isLoggedIn(context).then(loggedIn => {
		if (loggedIn) {
			console.log('CodeForgeX: User session restored.');
		}
	});

	// ─────────────────────────────────────────────────────────────
	// PHASE 1: URI handler for deep link redirect after browser login.
	// Website redirects to: vscode://<extension-id>/auth?token=JWT
	// VS Code intercepts this and fires the URI handler below.
	// ─────────────────────────────────────────────────────────────
const uriHandler = vscode.window.registerUriHandler({
	handleUri: async (uri: vscode.Uri) => {

		console.log("FULL URI:", uri.toString());
		console.log("PATH:", uri.path);
		console.log("QUERY:", uri.query);

		const params = new URLSearchParams(uri.query);
		const token = params.get('token');

		if (token) {
			await saveToken(context, token);
			vscode.window.showInformationMessage('CodeForgeX: Login successful!');
		} else {
			vscode.window.showErrorMessage('No token received.');
		}
	}
});

	context.subscriptions.push(uriHandler);

	// PHASE 1: Login command — opens browser to login page.
	// After login, website redirects back via vscode:// deep link.
	const loginCommand = vscode.commands.registerCommand(
		'codeforgex.login',
		async () => {
			const loginUrl = vscode.Uri.parse('https://codexly.netlify.app/login');
			await vscode.env.openExternal(loginUrl);
			vscode.window.showInformationMessage(
				'CodeForgeX: Opening login page. After login, you will be redirected back automatically.'
			);
		}
	);
	context.subscriptions.push(loginCommand);

	// PHASE 3: Logout command — deletes stored token.
	const logoutCommand = vscode.commands.registerCommand(
		'codeforgex.logout',
		async () => {
			await deleteToken(context);
			vscode.window.showInformationMessage('CodeForgeX: Logged out successfully.');
		}
	);
	context.subscriptions.push(logoutCommand);

	// ============================
	// Create Timer Status Bar
	// ============================
	timerStatusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	timerStatusBar.text = "⏱ 00:00";
	timerStatusBar.tooltip = "CodeForgeX Practice Timer";
	timerStatusBar.command = "codeforgex.timerControls";
	timerStatusBar.show();

	// Initialize timer
	practiceTimer = new PracticeTimer((time) => {
		timerStatusBar.text = `⏱ ${time}`;
	});

	// =====================================
	// START TIMER ON FIRST USER TYPING
	// FIX 2: Uses detectManualQuestion() so manually pasted questions
	//        trigger the timer correctly, not just AI-generated ones.
	// FIX 5: Re-evaluates hasExplanationFlag on every real document
	//        change so undo/redo keeps Remove Explanation in sync.
	// =====================================
	vscode.workspace.onDidChangeTextDocument(async (event) => {

		// Block ALL programmatic edits (editor.edit + save inside runService)
		if (isExtensionEditing) return;

		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		// Only track the active file
		if (event.document !== editor.document) return;

		// ─────────────────────────────────────────────────────────────
		// FIX 5: Undo/Redo state sync for explanation flag.
		// After every real document change (including undo/redo),
		// re-check whether storedExplanation still exists in the file
		// and sync hasExplanationFlag accordingly. This costs only one
		// string check per keystroke and needs no markers.
		// ─────────────────────────────────────────────────────────────
		if (storedExplanation) {
			const docText = event.document.getText();
			const explanationPresent = docText.includes(storedExplanation);
			if (explanationPresent !== hasExplanationFlag) {
				await updateContextFlag('codeforgex.hasExplanation', explanationPresent);
			}
		}

		// Auto-reset selection explanation if user manually deleted all explained blocks.
		// Check each stored block — if NONE of them exist in the file anymore, clear state.
		if (hasSelectionExplanationFlag && selectionExplainedBlocks.length > 0) {
			const currentContent = event.document.getText();
			const anyBlockStillExists = selectionExplainedBlocks.some(
				block => currentContent.includes(block)
			);
			if (!anyBlockStillExists) {
				hasSelectionExplanationFlag = false;
				selectionExplainedBlocks = [];
				selectionFileSnapshot = null;
			}
		}

		// ── FIX 2: Auto-detect manually pasted question ───────────────
		// Set hasQuestionFlag SYNCHRONOUSLY first so the timer check
		// on this SAME event sees the updated value immediately.
		// VS Code does not await async event handlers, so if we only
		// relied on the await inside updateContextFlag, the in-memory
		// flag would be set but the timer check below would have already
		// read the old value. Setting it directly here solves that.
		if (!hasQuestionFlag) {
			const docText = event.document.getText();
			if (detectManualQuestion(docText)) {
				hasQuestionFlag = true; // sync — makes timer check below work immediately
				updateContextFlag('codeforgex.hasQuestion', true); // async — updates VS Code context (no await needed here)
			}
		}

		// Timer already running — nothing to do
		if (timerStarted) return;

		// Only relevant once a question has been detected (AI or manual)
		if (!hasQuestionFlag) return;

		// A real keystroke: nothing was deleted/replaced AND new text arrived.
		// Cursor blinks, cursor moves, saves, and auto-format all produce either
		// zero contentChanges or changes where text === '' — they all fail here.
		// NOTE: rangeLength > 0 means text was replaced/deleted — we skip those
		// so that paste-over-selection doesn't trigger the timer either.
		const userTyped = event.contentChanges.some(change =>
			change.rangeLength === 0 && change.text.length > 0
		);

		if (!userTyped) return;

		// ✅ Real user typing confirmed — start the timer
		practiceTimer.start();
		timerStarted = true;

		vscode.window.showInformationMessage("Practice timer started");
	});

	// Helper function to update context flag and variable
	async function updateContextFlag(contextKey: string, value: boolean) {
		await vscode.commands.executeCommand('setContext', contextKey, value);
		if (contextKey === 'codeforgex.hasQuestion') hasQuestionFlag = value;
		if (contextKey === 'codeforgex.solutionVisible') solutionVisibleFlag = value;
		if (contextKey === 'codeforgex.hasExplanation') hasExplanationFlag = value;
		if (contextKey === 'codeforgex.hintVisible') hintVisibleFlag = value;
		if (contextKey === 'codeforgex.evaluationVisible') evaluationVisibleFlag = value;
	}

	// Build available actions based on current state.
	// Selection-based actions are injected by the caller after this returns.
	function buildAvailableActions(): string[] {
		const actions: string[] = [];

		// Before solution is shown, manage hint toggle
		if (hasQuestionFlag && !solutionVisibleFlag) {
			if (hintVisibleFlag) {
				actions.push('Hide Hint');
			} else {
				actions.push('Show Hint');
			}
			actions.push('Show Solution');
		}

		// After solution is shown
		if (solutionVisibleFlag) {
			if (!hasExplanationFlag) {
				actions.push('Explain Code');
			}
			if (evaluationVisibleFlag) {
				actions.push('Remove Evaluation');
			} else {
				actions.push('Evaluate Code');
			}
		}

		// Explanation handling
		if (hasExplanationFlag) {
			actions.push('Remove Explanation');
		}

		return actions;
	}

	// Re-sync all in-memory flags against actual file content.
	// Called every time startPractice dropdown is about to be shown,
	// so that deletes, undos, and redos are always reflected correctly.
	function syncFlagsFromFile(editor: vscode.TextEditor): void {
		const content = editor.document.getText();
		const trimmed = content.trim();

		// If file is empty or has no question marker and hasQuestionFlag thinks there is one,
		// reset everything — user wiped the file.
		if (hasQuestionFlag) {
			const hasAiQuestion = content.includes('Question (');
			const hasUserQuestion = isUserWrittenQuestion && trimmed.length > 0;
			if (!hasAiQuestion && !hasUserQuestion) {
				hasQuestionFlag = false;
				hintVisibleFlag = false;
				solutionVisibleFlag = false;
				hasExplanationFlag = false;
				evaluationVisibleFlag = false;
				return; // nothing more to check
			}
		}

		// Sync hint visibility — check if "Hint:" marker is in file
		if (hintVisibleFlag && !content.includes('Hint:')) {
			hintVisibleFlag = false;
		}

		// Sync solution visibility — check if stored solution code is in file
		if (solutionVisibleFlag && storedSolution && !content.includes(storedSolution)) {
			solutionVisibleFlag = false;
		}

		// Sync explanation visibility — check if stored explanation is in file
		if (hasExplanationFlag && storedExplanation && !content.includes(storedExplanation)) {
			hasExplanationFlag = false;
		}

		// Sync evaluation visibility — check if evaluation marker is in file
		if (evaluationVisibleFlag && !content.includes('Code Evaluation Summary:')) {
			evaluationVisibleFlag = false;
		}
	}

	// Returns true if question exists — either AI-generated header in file
	// OR in-memory flag is set (covers user-written question sessions where
	// no "Question (" header is inserted into the file).
	function detectQuestionInFile(editor: vscode.TextEditor): boolean {
		if (hasQuestionFlag) return true;
		const content = editor.document.getText();
		return content.includes('Question (');
	}

	// Feature 1: Detects if the file has a user-written question in comments
	// at the top (before any code), but NO AI-generated "Question (" header.
	// Returns the extracted question text, or null if not found.
	function extractUserWrittenQuestion(editor: vscode.TextEditor): string | null {
		const content = editor.document.getText();

		// If question already active (AI-generated or user-written), do not re-detect
		if (hasQuestionFlag) return null;
		if (content.includes('Question (')) return null;

		const lines = content.split('\n');
		const languageId = editor.document.languageId;
		const commentPrefix = languageId === 'python' ? '#' : '//';

		const questionLines: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();

			// Skip empty lines at top
			if (trimmed === '') {
				if (questionLines.length === 0) continue;
				else break; // blank line ends the comment block
			}

			// Must be a comment line
			if (!trimmed.startsWith(commentPrefix)) break;

			// Strip the comment prefix and collect
			const text = trimmed.replace(new RegExp(`^${commentPrefix}\\s*`), '').trim();
			if (text.length > 0) {
				questionLines.push(text);
			}
		}

		// Need at least one non-empty comment line to count as a question
		if (questionLines.length === 0) return null;

		return questionLines.join(' ');
	}

	const timerControlCommand = vscode.commands.registerCommand(
		"codeforgex.timerControls",
		async () => {

			const action = await vscode.window.showQuickPick(
				["Pause", "Resume", "Reset", "Stop"],
				{ placeHolder: "Timer Controls" }
			);

			if (!action) return;

			if (action === "Pause") {
				practiceTimer.pause();
			}

			if (action === "Resume") {
				practiceTimer.resume();
			}

			if (action === "Reset") {
				practiceTimer.reset();
				timerStarted = false;
			}

			if (action === "Stop") {
				const finalTime = practiceTimer.stop();
				vscode.window.showInformationMessage(
					`Practice completed in ${finalTime}`
				);
				timerStarted = false;
			}
		}
	);


	const disposable = vscode.commands.registerCommand(
		'codeforgex.startPractice',
		async () => {

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active file detected.');
				return;
			}

			const hasQuestion = detectQuestionInFile(editor);

			// ================================
			// GENERATE QUESTION
			// ================================
			if (!hasQuestion) {

				// ─────────────────────────────────────────────────────
				// FEATURE 1: Check if user wrote their own question
				// in comments at the top of the file.
				// If yes → generate hint+solution silently, set flags,
				// then fall through to dropdown immediately.
				// ─────────────────────────────────────────────────────
				const userQuestion = extractUserWrittenQuestion(editor);

				if (userQuestion) {
					const languageId = editor.document.languageId;

					let aiContent: string;
					try {
						// Show progress spinner so UI doesn't appear frozen during AI call
						aiContent = await vscode.window.withProgress(
							{
								location: vscode.ProgressLocation.Notification,
								title: "Generating hint and solution for your question...",
								cancellable: false
							},
							async () => {
								return await generatePracticeQuestion(
									userQuestion,
									languageId,
									'Medium'
								);
							}
						);
					} catch {
						vscode.window.showErrorMessage('AI generation failed.');
						return;
					}

					// Parse hint and solution only — question is not inserted
					const hintMatch = aiContent.match(/\[HINT\]([\s\S]*?)(?=\[SOLUTION\]|$)/);
					const solutionMatch = aiContent.match(/\[SOLUTION\]([\s\S]*)/);

					storedHint = hintMatch ? hintMatch[1].trim() : null;
					storedSolution = solutionMatch ? solutionMatch[1].trim() : null;
					isUserWrittenQuestion = true;

					// Reset practice tracking for new session
					hintsUsed = 0;
					solutionViewed = false;

					// Set flags exactly like normal generation
					await updateContextFlag('codeforgex.hintVisible', false);
					await updateContextFlag('codeforgex.solutionVisible', false);
					await updateContextFlag('codeforgex.hasExplanation', false);
					await updateContextFlag('codeforgex.evaluationVisible', false);
					await updateContextFlag('codeforgex.hasQuestion', true);

					// DO NOT return — fall through to the dropdown below immediately

				} else {
					// No user-written question found — normal AI question generation flow
					isUserWrittenQuestion = false;

					// Reset practice tracking for new session
					hintsUsed = 0;
					solutionViewed = false;

					// Reset context keys for new question
					await updateContextFlag('codeforgex.hintVisible', false);
					await updateContextFlag('codeforgex.solutionVisible', false);
					await updateContextFlag('codeforgex.hasExplanation', false);
					await updateContextFlag('codeforgex.evaluationVisible', false);

					const fileName = editor.document.fileName;
					const baseName = fileName.split('/').pop()?.toLowerCase() || '';

					let detectedTopic = 'General Programming';

					if (baseName.includes('binary') || baseName.includes('search')) {
						detectedTopic = 'Searching';
					} else if (baseName.includes('sort')) {
						detectedTopic = 'Sorting';
					} else if (baseName.includes('linked') || baseName.includes('list')) {
						detectedTopic = 'Linked List';
					}

					const topicDecision = await vscode.window.showInformationMessage(
						`Detected Topic: ${detectedTopic}`,
						{ modal: true },
						'Continue',
						'Change Topic'
					);

					if (!topicDecision) return;

					if (topicDecision === 'Change Topic') {
						const manualTopic = await vscode.window.showInputBox({
							prompt: 'Enter topic name manually'
						});

						if (manualTopic && manualTopic.trim() !== '') {
							detectedTopic = manualTopic.trim();
						}
					}

					const difficulty = await vscode.window.showQuickPick(
						['Easy', 'Medium', 'Hard'],
						{ placeHolder: 'Select difficulty level' }
					);

					if (!difficulty) return;

					const languageId = editor.document.languageId;
					let aiContent: string;

					try {
						aiContent = await vscode.window.withProgress(
							{
								location: vscode.ProgressLocation.Notification,
								title: "Generating practice question...",
								cancellable: false
							},
							async () => {
								return await generatePracticeQuestion(
									detectedTopic,
									languageId,
									difficulty
								);
							}
						);
					} catch {
						vscode.window.showErrorMessage('AI generation failed.');
						return;
					}

					const commentPrefix = languageId === 'python' ? '# ' : '// ';
					const headerLine = `${commentPrefix}Question (${difficulty})\n\n`;

					const questionMatch = aiContent.match(/\[QUESTION\]([\s\S]*?)(?=\[HINT\]|\[SOLUTION\]|$)/);
					const hintMatch = aiContent.match(/\[HINT\]([\s\S]*?)(?=\[SOLUTION\]|$)/);
					const solutionMatch = aiContent.match(/\[SOLUTION\]([\s\S]*)/);

					storedHint = hintMatch ? hintMatch[1].trim() : null;
					storedSolution = solutionMatch ? solutionMatch[1].trim() : null;

					let finalContent = headerLine;

					if (questionMatch) {
						finalContent += questionMatch[1]
							.trim()
							.split('\n')
							.map(line => commentPrefix + line)
							.join('\n') + '\n\n';
					}

					// Guard: question insertion must not start the timer
					isExtensionEditing = true;
					await editor.edit(editBuilder => {
						editBuilder.insert(
							new vscode.Position(0, 0),
							finalContent
						);
					});
					isExtensionEditing = false;

					await vscode.workspace.getConfiguration('editor').update(
						'wordWrap',
						'on',
						vscode.ConfigurationTarget.Workspace
					);

					// Set context key and return — normal flow ends here
					await updateContextFlag('codeforgex.hasQuestion', true);
					return;
				}
			}

			// ================================
			// IF QUESTION EXISTS → Show Tools
			// (also reached after user-written question generation above)
			// FIX 1: Wrapped in while(true) loop so QuickPick reappears
			// after each action. Breaks only when user presses Escape.
			// ================================

			// Re-sync all flags from actual file content before building dropdown.
			// This ensures deletes, undos, and redos are always reflected correctly.
			syncFlagsFromFile(editor);

			// If syncFlagsFromFile determined there's no longer a question,
			// treat this click as a fresh start.
			if (!hasQuestionFlag) {
				vscode.window.showInformationMessage('No question found. Use Start Practice to generate one.');
				return;
			}

			// FIX 1: while loop keeps QuickPick alive after each action.
			// User presses Escape (action === undefined) to dismiss.
			while (true) {

				// Selection check: independent of all question state flags.
				const selection = editor.selection;
				const hasSelection = !selection.isEmpty;

				// Build state-based actions first
				const availableActions = buildAvailableActions();

				// Inject selection actions at the top:
				// - "Explain Selection" appears whenever text is selected (always)
				// - "Remove Selection Explanation" appears whenever explanations exist
				// These are NOT mutually exclusive — both can appear simultaneously.
				if (hasSelectionExplanationFlag) {
					availableActions.unshift('Remove Selection Explanation');
				}
				if (hasSelection) {
					availableActions.unshift('Explain Selection');
				}

				if (availableActions.length === 0) {
					vscode.window.showInformationMessage('No actions available.');
					break;
				}

				const action = await vscode.window.showQuickPick(
					availableActions,
					{ placeHolder: 'Select action — press Esc to close' }
				);

				// Escape pressed → exit loop
				if (!action) break;

				if (action === 'Explain Selection') {
					await vscode.commands.executeCommand('codeforgex.explainSelection');
				}

				if (action === 'Remove Selection Explanation') {
					await vscode.commands.executeCommand('codeforgex.removeSelectionExplanation');
				}

				if (action === 'Show Hint') {
					await vscode.commands.executeCommand('codeforgex.showHint');
				}

				if (action === 'Hide Hint') {
					await vscode.commands.executeCommand('codeforgex.hideHint');
				}

				if (action === 'Show Solution') {
					await vscode.commands.executeCommand('codeforgex.showSolution');
				}

				if (action === 'Explain Code') {
					await vscode.commands.executeCommand('codeforgex.explainCode');
				}

				if (action === 'Evaluate Code') {
					await vscode.commands.executeCommand('codeforgex.evaluateSolution');
				}

				if (action === 'Remove Evaluation') {
					await vscode.commands.executeCommand('codeforgex.removeEvaluation');
				}

				if (action === 'Remove Explanation') {
					await vscode.commands.executeCommand('codeforgex.removeExplanation');
				}
			}
		}
	);

	const hintCommand = vscode.commands.registerCommand(
		'codeforgex.showHint',
		async () => {

			const editor = vscode.window.activeTextEditor;
			if (!editor || !storedHint) {
				vscode.window.showInformationMessage('No hint available.');
				return;
			}

			if (editor.document.getText().includes('Hint:')) {
				vscode.window.showInformationMessage('Hint already revealed.');
				return;
			}

			const commentPrefix = editor.document.languageId === 'python' ? '# ' : '// ';

			const hintContent =
				`\n${commentPrefix}Hint:\n` +
				storedHint
					.split('\n')
					.map(line => commentPrefix + line)
					.join('\n') +
				'\n\n';

			// Guard: hint insertion must not start the timer
			isExtensionEditing = true;
			await editor.edit(editBuilder => {
				editBuilder.insert(
					new vscode.Position(editor.document.lineCount, 0),
					hintContent
				);
			});
			isExtensionEditing = false;

			// PHASE 2: Track hint usage for practice data sync
			hintsUsed++;

			// Set context key to show hide hint button
			await updateContextFlag('codeforgex.hintVisible', true);
		}
	);

	const hideHintCommand = vscode.commands.registerCommand(
		'codeforgex.hideHint',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active file.');
				return;
			}

			const currentText = editor.document.getText();
			const lines = currentText.split('\n');
			const commentPrefix = editor.document.languageId === 'python' ? '# ' : '// ';
			const commentChar = commentPrefix.trim(); // '#' or '//'

			// Find the line that starts with "# Hint:" or "// Hint:"
			let hintStartIndex = -1;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].trim().startsWith(commentPrefix + 'Hint:')) {
					hintStartIndex = i;
					break;
				}
			}

			if (hintStartIndex === -1) {
				vscode.window.showErrorMessage('Hint not found.');
				return;
			}

			// Find end of hint block (consecutive comment lines)
			let hintEndIndex = hintStartIndex;
			for (let i = hintStartIndex + 1; i < lines.length; i++) {
				const trimmedLine = lines[i].trim();
				// Continue if line is empty or starts with comment character
				if (trimmedLine === '' || trimmedLine.startsWith(commentChar)) {
					hintEndIndex = i;
					// Stop at blank line
					if (trimmedLine === '') {
						break;
					}
				} else {
					// Non-comment line found, stop here
					hintEndIndex = i - 1;
					break;
				}
			}

			// Remove the hint block
			lines.splice(hintStartIndex, hintEndIndex - hintStartIndex + 1);
			const newText = lines.join('\n');

			// Guard: hint removal must not start the timer
			isExtensionEditing = true;
			await editor.edit(editBuilder => {
				const fullRange = new vscode.Range(
					editor.document.positionAt(0),
					editor.document.positionAt(currentText.length)
				);
				editBuilder.replace(fullRange, newText);
			});
			isExtensionEditing = false;

			await updateContextFlag('codeforgex.hintVisible', false);
			vscode.window.showInformationMessage('Hint hidden.');
		}
	);

	const removeHintCommand = vscode.commands.registerCommand(
		'codeforgex.removeHint',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active file.');
				return;
			}

			const currentText = editor.document.getText();
			const lines = currentText.split('\n');
			const commentPrefix = editor.document.languageId === 'python' ? '# ' : '// ';
			const commentChar = commentPrefix.trim(); // '#' or '//'

			// Find the line that starts with "# Hint:" or "// Hint:"
			let hintStartIndex = -1;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].trim().startsWith(commentPrefix + 'Hint:')) {
					hintStartIndex = i;
					break;
				}
			}

			if (hintStartIndex === -1) {
				vscode.window.showErrorMessage('Hint not found.');
				return;
			}

			// Find end of hint block (consecutive comment lines)
			let hintEndIndex = hintStartIndex;
			for (let i = hintStartIndex + 1; i < lines.length; i++) {
				const trimmedLine = lines[i].trim();
				// Continue if line is empty or starts with comment character
				if (trimmedLine === '' || trimmedLine.startsWith(commentChar)) {
					hintEndIndex = i;
					// Stop at blank line
					if (trimmedLine === '') {
						break;
					}
				} else {
					// Non-comment line found, stop here
					hintEndIndex = i - 1;
					break;
				}
			}

			// Remove the hint block
			lines.splice(hintStartIndex, hintEndIndex - hintStartIndex + 1);
			const newText = lines.join('\n');

			// Guard: hint removal must not start the timer
			isExtensionEditing = true;
			await editor.edit(editBuilder => {
				const fullRange = new vscode.Range(
					editor.document.positionAt(0),
					editor.document.positionAt(currentText.length)
				);
				editBuilder.replace(fullRange, newText);
			});
			isExtensionEditing = false;

			await updateContextFlag('codeforgex.hintVisible', false);
			vscode.window.showInformationMessage('Hint removed.');
		}
	);

	const solutionCommand = vscode.commands.registerCommand(
		'codeforgex.showSolution',
		async () => {

			const editor = vscode.window.activeTextEditor;
			if (!editor || !storedSolution) {
				vscode.window.showInformationMessage('No solution available.');
				return;
			}

			const currentText = editor.document.getText();

			if (currentText.includes(storedSolution)) {
				vscode.window.showInformationMessage('Solution already revealed.');
				return;
			}

			const solutionContent = `\n${storedSolution}\n\n`;

			// Guard: solution insertion must not start the timer
			isExtensionEditing = true;
			await editor.edit(editBuilder => {
				editBuilder.insert(
					new vscode.Position(editor.document.lineCount, 0),
					solutionContent
				);
			});
			isExtensionEditing = false;

			// PHASE 2: Track solution view for practice data sync
			solutionViewed = true;

			// Set context key to show explain and evaluate options
			await updateContextFlag('codeforgex.solutionVisible', true);
		}
	);

	const evaluateCommand = vscode.commands.registerCommand(
		'codeforgex.evaluateSolution',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active file.');
				return;
			}

			if (!storedSolution) {
				vscode.window.showErrorMessage('No solution available for evaluation.');
				return;
			}

			const userCode = editor.document.getText();
			const languageId = editor.document.languageId;
			const commentPrefix = languageId === 'python' ? '# ' : '// ';

			let evaluationResult: string;

			try {
				evaluationResult = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Evaluating your code...",
						cancellable: false
					},
					async () => {
						return await evaluateCode(languageId, storedSolution!, userCode);
					}
				);

				// Parse evaluation response
				const summaryMatch = evaluationResult.match(/Code Evaluation Summary:([\s\S]*?)(?=Suggestions:|$)/);
				const suggestionsMatch = evaluationResult.match(/Suggestions:([\s\S]*?)$/);

				const summary = summaryMatch ? summaryMatch[1].trim() : evaluationResult;
				const suggestionsText = suggestionsMatch ? suggestionsMatch[1].trim() : '';

				// Check if evaluation already exists
				const currentFullText = editor.document.getText();
				if (currentFullText.includes('Code Evaluation Summary:')) {
					vscode.window.showWarningMessage('Evaluation already exists. Remove it before running again.');
					return;
				}

				// Insert summary at end of file
				const summaryBlock =
					`\n\n${commentPrefix}Evaluation:\n` +
					summary
						.split('\n')
						.map(line => commentPrefix + (line.trim() ? line : ''))
						.join('\n') +
					'\n';

				// Guard: evaluation insertion must not start the timer
				isExtensionEditing = true;
				await editor.edit(editBuilder => {
					editBuilder.insert(
						new vscode.Position(editor.document.lineCount, 0),
						summaryBlock
					);
				});
				isExtensionEditing = false;

				// Set evaluation flag
				await updateContextFlag('codeforgex.evaluationVisible', true);

				if (suggestionsText.length > 0) {
					const lineMatches = suggestionsText.matchAll(/LINE\s*(\d+):([\s\S]*?)(?=LINE\s*\d+:|$)/gi);
					const suggestions = Array.from(lineMatches).map(match => ({
						lineNumber: parseInt(match[1]),
						content: match[2].trim()
					}));

					// Sort by line number descending to avoid offset issues
					suggestions.sort((a, b) => b.lineNumber - a.lineNumber);

					const updatedText = editor.document.getText();
					const lines = updatedText.split('\n');

					for (const suggestion of suggestions) {
						const lineIndex = suggestion.lineNumber - 1;

						if (lineIndex >= 0 && lineIndex < lines.length) {
							// Check if suggestion already exists
							if (!lines[lineIndex - 1]?.includes('Suggestion:')) {
								const suggestionLines = suggestion.content
									.split('\n')
									.filter(line => line.trim().length > 0)
									.map(line => commentPrefix + line.trim())
									.join('\n');

								const insertionPos = new vscode.Position(lineIndex, 0);

								// Guard: each inline suggestion must not start the timer
								isExtensionEditing = true;
								await editor.edit(editBuilder => {
									editBuilder.insert(insertionPos, suggestionLines + '\n');
								});
								isExtensionEditing = false;
							}
						}
					}
				}

				vscode.window.showInformationMessage('Code evaluation complete. Review suggestions in file.');

			} catch (error) {
				vscode.window.showErrorMessage('Code evaluation failed. Please try again.');
				console.error('Evaluation error:', error);
			}
		}
	);

	const explainCommand = vscode.commands.registerCommand(
		'codeforgex.explainCode',
		async () => {
			console.log("Explain Code clicked");
			vscode.window.showInformationMessage("Explain command triggered");

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage('No active file.');
				return;
			}

			const fullText = editor.document.getText();

			if (!storedSolution || !fullText.includes(storedSolution)) {
				vscode.window.showInformationMessage('Generate solution first.');
				return;
			}

			try {

				const explainedCode = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Explaining code...",
						cancellable: false
					},
					async () => {
						return await explainCode(editor.document.languageId, storedSolution!);
					}
				);

				const currentText = editor.document.getText();

				// ── FIX 4: Safe line-boundary insertion ──────────────────────
				// Old approach: currentText.replace(storedSolution, explainedCode)
				// Problem: raw string replace can land mid-line and break syntax.
				// Fix: locate the exact character position of storedSolution,
				// convert to VS Code positions, snap both ends to full line
				// boundaries, then replace that clean Range. Never mid-line.
				const solutionStartIndex = currentText.indexOf(storedSolution!);
				if (solutionStartIndex === -1) {
					vscode.window.showInformationMessage('Solution block not found in file.');
					return;
				}

				const solutionEndIndex = solutionStartIndex + storedSolution!.length;
				const rawStartPos = editor.document.positionAt(solutionStartIndex);
				const rawEndPos = editor.document.positionAt(solutionEndIndex);

				// Snap to line boundaries so insertion is always clean
				const safeStart = new vscode.Position(rawStartPos.line, 0);
				const safeEnd = new vscode.Position(
					rawEndPos.line,
					editor.document.lineAt(rawEndPos.line).text.length
				);
				const safeRange = new vscode.Range(safeStart, safeEnd);

				// Guard: explanation replacement must not start the timer
				isExtensionEditing = true;
				await editor.edit(editBuilder => {
					editBuilder.replace(safeRange, explainedCode.trim());
				});
				isExtensionEditing = false;

				// Store explanation and update context flag
				storedExplanation = explainedCode.trim();
				await updateContextFlag('codeforgex.hasExplanation', true);

			} catch (error) {
				vscode.window.showErrorMessage('Explanation failed.');
			}
		}
	);

	const removeExplanationCommand = vscode.commands.registerCommand(
		'codeforgex.removeExplanation',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !storedExplanation) {
				vscode.window.showInformationMessage('No explanation to remove.');
				return;
			}

			const currentText = editor.document.getText();

			// Revert to stored solution
			if (storedSolution && currentText.includes(storedExplanation)) {
				const revertedText = currentText.replace(
					storedExplanation,
					storedSolution
				);

				// Guard: revert replacement must not start the timer
				isExtensionEditing = true;
				await editor.edit(editBuilder => {
					const fullRange = new vscode.Range(
						editor.document.positionAt(0),
						editor.document.positionAt(currentText.length)
					);
					editBuilder.replace(fullRange, revertedText);
				});
				isExtensionEditing = false;

				// Clear explanation and update context flag
				storedExplanation = null;
				await updateContextFlag('codeforgex.hasExplanation', false);
			}
		}
	);

	const removeEvaluationCommand = vscode.commands.registerCommand(
		'codeforgex.removeEvaluation',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active file.');
				return;
			}

			const currentText = editor.document.getText();
			const lines = currentText.split('\n');
			const commentPrefix = editor.document.languageId === 'python' ? '# ' : '// ';
			const commentChar = commentPrefix.trim(); // '#' or '//'

			// Find the line that starts with "# Evaluation:" or "// Evaluation:"
			let evalStartIndex = -1;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].trim().startsWith(commentPrefix + 'Evaluation:')) {
					evalStartIndex = i;
					break;
				}
			}

			if (evalStartIndex === -1) {
				vscode.window.showErrorMessage('Evaluation not found.');
				return;
			}

			// Find end of evaluation block (consecutive comment lines)
			let evalEndIndex = evalStartIndex;
			for (let i = evalStartIndex + 1; i < lines.length; i++) {
				const trimmedLine = lines[i].trim();
				// Continue if line is empty or starts with comment character
				if (trimmedLine === '' || trimmedLine.startsWith(commentChar)) {
					evalEndIndex = i;
					// Stop at blank line
					if (trimmedLine === '') {
						break;
					}
				} else {
					// Non-comment line found, stop here
					evalEndIndex = i - 1;
					break;
				}
			}

			// Remove the evaluation block
			lines.splice(evalStartIndex, evalEndIndex - evalStartIndex + 1);
			const newText = lines.join('\n');

			// Guard: evaluation removal must not start the timer
			isExtensionEditing = true;
			await editor.edit(editBuilder => {
				const fullRange = new vscode.Range(
					editor.document.positionAt(0),
					editor.document.positionAt(currentText.length)
				);
				editBuilder.replace(fullRange, newText);
			});
			isExtensionEditing = false;

			await updateContextFlag('codeforgex.evaluationVisible', false);
			vscode.window.showInformationMessage('Evaluation removed.');
		}
	);

	// ─────────────────────────────────────────────────────────────
	// RUN COMMAND
	// isExtensionEditing wraps runActiveFile() to block the
	// save() inside runService from accidentally starting the timer.
	// ─────────────────────────────────────────────────────────────
	const runCommand = vscode.commands.registerCommand(
		'codeforgex.run',
		async () => {

			// Block the save() inside runActiveFile from triggering the timer
			isExtensionEditing = true;
			const result = await runActiveFile();
			isExtensionEditing = false;

			if (result.success) {
				// Stop timer ONLY if it was actually started by real user typing
				if (timerStarted) {
					const finalTime = practiceTimer.stop();
					timerStarted = false;
					vscode.window.showInformationMessage(
						`Practice completed in ${finalTime}`
					);

					// ─────────────────────────────────────────────────────
					// PHASE 2: Send practice data to backend after success.
					// All session data is available here in extension.ts —
					// no changes needed in runService.ts.
					// ─────────────────────────────────────────────────────
					const editor = vscode.window.activeTextEditor;
					const language = editor?.document.languageId ?? 'unknown';
					const question = storedSolution
						? (storedHint ?? 'Practice session')
						: 'Practice session';

					sendPracticeData(context, {
						question: question,
						timeTaken: finalTime,
						hintsUsed: hintsUsed,
						solutionViewed: solutionViewed,
						language: language,
						date: new Date().toISOString()
					}); // intentionally not awaited — fire and forget, don't block UI
				}
			} else {
				vscode.window.showErrorMessage(
					result.error || "Execution failed."
				);
			}
		}
	);

	// ─────────────────────────────────────────────────────────────
	// FEATURE 2: EXPLAIN SELECTION
	// Explains only the currently selected lines of code.
	// Inserts comment-per-line explanations above each selected line.
	// Tracked separately from storedExplanation (full-solution explain).
	// ─────────────────────────────────────────────────────────────
	const explainSelectionCommand = vscode.commands.registerCommand(
		'codeforgex.explainSelection',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage('No active file.');
				return;
			}

			const selection = editor.selection;
			if (selection.isEmpty) {
				vscode.window.showInformationMessage('No text selected. Please select code first.');
				return;
			}

			// ── BUG 1 FIX: Expand selection to full line boundaries ───────
			// If user selects a partial line (e.g. just "in" from "for char in s:"),
			// replacing that mid-line token with a multi-line explained block
			// breaks indentation and splits the line, causing syntax errors.
			// Fix: always expand to complete lines — from col 0 of the first
			// selected line to the end of the last selected line.
			// This means the AI sees and replaces complete lines only.
			const startLine = selection.start.line;
			const endLine = selection.end.line;
			const fullLineRange = new vscode.Range(
				new vscode.Position(startLine, 0),
				new vscode.Position(endLine, editor.document.lineAt(endLine).text.length)
			);

			// Capture the FULL LINES of selected text to send to AI
			const selectedText = editor.document.getText(fullLineRange);
			const languageId = editor.document.languageId;

			let explainedBlock: string;

			try {
				explainedBlock = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Explaining selection...",
						cancellable: false
					},
					async () => {
						return await explainSelection(languageId, selectedText);
					}
				);
			} catch {
				vscode.window.showErrorMessage('Explanation failed. Please try again.');
				return;
			}

			// On FIRST explain: save a snapshot of the full file before any changes.
			// This snapshot is what "Remove Selection Explanation" restores.
			if (!hasSelectionExplanationFlag) {
				selectionFileSnapshot = editor.document.getText();
			}

			// Track this explained block for auto-detection of manual deletion
			selectionExplainedBlocks.push(explainedBlock);
			hasSelectionExplanationFlag = true;

			// Replace the full-line range (not the original partial selection)
			// so the explained block always lands on clean line boundaries
			isExtensionEditing = true;
			await editor.edit(editBuilder => {
				editBuilder.replace(fullLineRange, explainedBlock);
			});
			isExtensionEditing = false;

			vscode.window.showInformationMessage('Selection explained. Select more to explain again, or use Remove Selection Explanation to remove all.');
		}
	);

	// ─────────────────────────────────────────────────────────────
	// FEATURE 2: REMOVE SELECTION EXPLANATION
	// Reverts the explained block back to the original selected code.
	// ─────────────────────────────────────────────────────────────
	const removeSelectionExplanationCommand = vscode.commands.registerCommand(
		'codeforgex.removeSelectionExplanation',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !hasSelectionExplanationFlag || !selectionFileSnapshot) {
				vscode.window.showInformationMessage('No selection explanation to remove.');
				return;
			}

			// Restore the full file snapshot taken before the first explain.
			// This removes ALL accumulated selection explanations at once,
			// regardless of how many times the user selected and explained.
			isExtensionEditing = true;
			await editor.edit(editBuilder => {
				const fullRange = new vscode.Range(
					editor.document.positionAt(0),
					editor.document.positionAt(editor.document.getText().length)
				);
				editBuilder.replace(fullRange, selectionFileSnapshot!);
			});
			isExtensionEditing = false;

			// Clear all selection explanation state
			hasSelectionExplanationFlag = false;
			selectionExplainedBlocks = [];
			selectionFileSnapshot = null;

			vscode.window.showInformationMessage('All selection explanations removed.');
		}
	);
	const checkTokenCommand = vscode.commands.registerCommand(
	'codeforgex.checkToken',
	async () => {
		const token = await context.secrets.get('CFX_AUTH_TOKEN');
		if (token) {
			vscode.window.showInformationMessage(`Stored Token: ${token}`);
		} else {
			vscode.window.showInformationMessage('No token found in storage.');
		}
	}
);

	context.subscriptions.push(
		disposable,
		hintCommand,
		hideHintCommand,
		removeHintCommand,
		solutionCommand,
		evaluateCommand,
		explainCommand,
		removeExplanationCommand,
		removeEvaluationCommand,
		runCommand,
		timerControlCommand,
		explainSelectionCommand,
		removeSelectionExplanationCommand,
		checkTokenCommand
	);
}

export function deactivate() {}