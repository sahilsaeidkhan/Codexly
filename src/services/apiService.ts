import * as vscode from 'vscode';
import { getToken, deleteToken } from './authService';

const API_BASE = 'https://codexly.netlify.app/api';

// Shape of practice data sent after each successful run
export interface PracticeData {
    question: string;
    timeTaken: string;      // formatted "MM:SS"
    hintsUsed: number;
    solutionViewed: boolean;
    language: string;
    date: string;           // ISO 8601 date string
}

/**
 * Sends practice session data to the backend after a successful run.
 *
 * Phase 2: POST /api/practice with Bearer token.
 * Phase 4: Handles fetch failures and 401 session expiry cleanly.
 *
 * Returns true if data was sent successfully, false otherwise.
 */
export async function sendPracticeData(
    context: vscode.ExtensionContext,
    data: PracticeData
): Promise<boolean> {
    console.log("🔥 sendPracticeData CALLED");
console.log("Data being sent:", data);


    // Get stored token — if missing, user is not logged in
    const token = await getToken(context);

    if (!token) {
        vscode.window.showErrorMessage(
            'CodeForgeX: Please login first to save your practice data. Use "CodeForgeX: Login" command.'
        );
        return false;
    }

    try {
        const response = await fetch(`${API_BASE}/practice`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        // Phase 4: 401 means token is expired or invalid — auto logout
        if (response.status === 401) {
            await deleteToken(context);
            vscode.window.showErrorMessage(
                'CodeForgeX: Session expired. Please login again using "CodeForgeX: Login".'
            );
            return false;
        }

        if (!response.ok) {
            vscode.window.showErrorMessage(
                `CodeForgeX: Failed to save practice data (${response.status}). Will try again next time.`
            );
            return false;
        }

        return true;

    } catch (error: any) {
        // Phase 4: Network failure or fetch error — show message, do not crash
        vscode.window.showErrorMessage(
            'CodeForgeX: Could not reach server. Practice data not saved. Check your connection.'
        );
        return false;
    }
}