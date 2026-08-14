import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
/**
 * Vite config for the agent console.
 *
 * Tauri drives this: `beforeDevCommand` starts the dev server on a fixed port
 * and points the webview at it, so the port must not auto-increment or the
 * webview loads nothing.
 */
export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
        watch: {
            // Rust artefacts churn constantly during `tauri dev`; watching them
            // would trigger endless reloads.
            ignored: ['**/src-tauri/**'],
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        // Tauri ships its own WebView2 runtime, so there is no need to transpile
        // down for legacy browsers.
        target: 'chrome110',
        sourcemap: true,
    },
});
//# sourceMappingURL=vite.config.js.map