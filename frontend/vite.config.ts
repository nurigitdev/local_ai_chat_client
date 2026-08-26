import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        // Wails proxies the dev server through IPv4 (127.0.0.1). Binding Vite
        // explicitly to the same address avoids a localhost/IPv6 mismatch.
        host: '127.0.0.1',
    },
});
