import * as vscode from 'vscode';

// Secret storage key — consistent across all auth operations
const TOKEN_KEY = 'CFX_AUTH_TOKEN';

/**
 * Saves the JWT token securely using VS Code's SecretStorage.
 * SecretStorage is encrypted on disk by VS Code — safe for tokens.
 */
export async function saveToken(
    context: vscode.ExtensionContext,
    token: string
): Promise<void> {
    await context.secrets.store(TOKEN_KEY, token);
}

/**
 * Retrieves the stored JWT token.
 * Returns null if no token is stored (user not logged in).
 */
export async function getToken(
    context: vscode.ExtensionContext
): Promise<string | null> {
    const token = await context.secrets.get(TOKEN_KEY);
    return token ?? null;
}

/**
 * Deletes the stored JWT token.
 * Used on logout and on 401 session expiry.
 */
export async function deleteToken(
    context: vscode.ExtensionContext
): Promise<void> {
    await context.secrets.delete(TOKEN_KEY);
}

/**
 * Returns true if a token is currently stored.
 * Does NOT validate the token against the server —
 * validation happens implicitly on the first API call.
 */
export async function isLoggedIn(
    context: vscode.ExtensionContext
): Promise<boolean> {
    const token = await context.secrets.get(TOKEN_KEY);
    return token !== undefined && token !== null && token.length > 0;
}