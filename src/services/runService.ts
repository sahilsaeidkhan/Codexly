import * as vscode from "vscode";
import { getLanguageConfig } from "./languageConfig";

export interface RunResult {
    success: boolean;
    output: string;
    error?: string;
}

/**
 * Runs the currently active file in a VS Code terminal,
 * exactly like the Code Runner extension does.
 */
export async function runActiveFile(): Promise<RunResult> {

    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return {
            success: false,
            output: "",
            error: "No active file."
        };
    }

    // Save file before running (silent save)
    await editor.document.save();

    const filePath = editor.document.fileName;
    const languageId = editor.document.languageId;

    const config = getLanguageConfig(languageId, filePath);

    if (!config) {
        return {
            success: false,
            output: "",
            error: `Language "${languageId}" is not supported. Supported: Python, JavaScript, TypeScript, Java, C, C++, Go, Ruby.`
        };
    }

    try {
        // Build the full shell command string to send to terminal
        let terminalCommand = "";

        if (config.compile) {
            // Compile first, then run — joined with && so run only happens on success
            // e.g. Java:  javac file.java && java -cp /dir ClassName
            // e.g. C/C++: gcc file.c -o output && ./output
            const compileCmd = `${config.compile.command} ${config.compile.args.join(" ")}`;
            const runCmd = `${config.run.command} ${config.run.args.join(" ")}`;
            terminalCommand = `${compileCmd} && ${runCmd}`;
        } else {
            // Interpret directly
            // e.g. Python:     python3 file.py
            // e.g. JavaScript: node file.js
            // e.g. TypeScript: npx ts-node file.ts
            // e.g. Go:         go run file.go
            terminalCommand = `${config.run.command} ${config.run.args.join(" ")}`;
        }

        // Reuse existing "CodeForgeX" terminal if open, otherwise create one.
        // This mirrors how Code Runner reuses its output channel.
        let terminal = vscode.window.terminals.find(t => t.name === "CodeForgeX");
        if (!terminal) {
            terminal = vscode.window.createTerminal("CodeForgeX");
        }

        // Show the terminal panel so user sees output (true = keep editor focus)
        terminal.show(true);

        // Fire the command — user sees real-time output just like Code Runner
        terminal.sendText(terminalCommand);

        // Return success immediately so extension.ts stops the timer.
        // We don't await terminal exit — the terminal is live and interactive.
        return {
            success: true,
            output: "Running in terminal..."
        };

    } catch (err: any) {
        return {
            success: false,
            output: "",
            error: err.message || "Execution failed."
        };
    }
}