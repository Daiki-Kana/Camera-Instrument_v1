import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { qrcode } from 'vite-plugin-qrcode';

// iPhoneのSafariからLAN経由でアクセスしてカメラを使用するため、ローカルHTTPSを有効化し、QRコードを表示
export default defineConfig({
  plugins: [
    basicSsl(),
    qrcode() // 開発サーバー起動時にモバイル接続用QRコードをターミナルに表示
  ],
  server: {
    host: true, // 外部デバイス（iPhoneなど）からのアクセスを許可
    port: 5173
  }
});
