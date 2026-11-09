import { useState } from "react";
import { Check, Copy, Info, QrCode, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { useTranslation } from "../context/LanguageContext";
import type { SyncConfig } from "../api";
import { Modal } from "./Modal";

interface QrVaultModalProps {
  isOpen: boolean;
  syncConfig: SyncConfig;
  onClose: () => void;
}

interface QrPayload {
  type: "passdroid-vault-link";
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  remoteFile: string;
}

// UTF-8-safe base64: plain btoa() throws on any character outside Latin-1
// (e.g. "€" or an emoji in the FTP password), which made the QR silently fail.
// ASCII payloads encode to exactly the same string as before, so old QR codes
// still parse.
function toBase64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64Utf8(b64: string): string {
  const binary = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeQrPayload(config: SyncConfig): string {
  const payload: QrPayload = {
    type: "passdroid-vault-link",
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    remoteDir: config.remoteDir,
    remoteFile: config.remoteFile,
  };
  return `pdvault://${toBase64Utf8(JSON.stringify(payload))}`;
}

export function parseQrPayload(text: string): SyncConfig | null {
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith("pdvault://")) {
      jsonStr = fromBase64Utf8(jsonStr.replace("pdvault://", ""));
    }
    const data = JSON.parse(jsonStr);
    if (data.type !== "passdroid-vault-link" || !data.host) return null;
    return {
      enabled: true,
      // Payloads from before the protocol field was carried were plain FTP.
      protocol: data.protocol || "ftp",
      host: data.host,
      port: data.port || 21,
      username: data.username || "",
      password: data.password || "",
      remoteDir: data.remoteDir || "vault",
      remoteFile: data.remoteFile || "passdroid.pdvault",
    };
  } catch {
    return null;
  }
}

export function QrVaultModal({ isOpen, syncConfig, onClose }: QrVaultModalProps) {
  const { t } = useTranslation();
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generateQr = async () => {
    const encoded = encodeQrPayload(syncConfig);
    const url = await QRCode.toDataURL(encoded, {
      width: 280,
      margin: 2,
      color: {
        dark: "#17211f",
        light: "#ffffff",
      },
    });
    setQrUrl(url);
  };

  // Generate QR on open
  if (isOpen && !qrUrl) {
    void generateQr();
  }

  const handleCopyConfig = async () => {
    const encoded = encodeQrPayload(syncConfig);
    await navigator.clipboard.writeText(encoded);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setQrUrl(null);
    setCopied(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <Modal title={t("qrLinkDevice")} eyebrow={t("tabSync")} onClose={handleClose} className="qr-modal">
      {/* QR Code Image */}
      <div className="qr-image-container">
        {qrUrl ? (
          <img src={qrUrl} alt={t("qrAlt")} className="qr-image" />
        ) : (
          <div className="qr-placeholder">
            <QrCode size={48} aria-hidden />
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="qr-info">
        <h3>
          <Info size={16} aria-hidden />
          {t("qrHowTitle")}
        </h3>
        <p>{t("qrHowBody")}</p>
        <div className="qr-security-note">
          <ShieldCheck size={18} aria-hidden />
          <p>{t("qrSecurityNote")}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="qr-modal-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={handleCopyConfig}
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {t("qrCopyConfig")}
        </button>
      </div>
    </Modal>
  );
}
