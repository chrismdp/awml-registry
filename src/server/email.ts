// Email goes out through one small interface. Only the development sender,
// which logs the link, is built; the hosted service's provider is not chosen yet.
export interface EmailSender {
  sendMagicLink(to: string, url: string): Promise<void>;
}

export const consoleSender: EmailSender = {
  async sendMagicLink(to, url) {
    console.log(`[awml] sign-in link for ${to}: ${url}`);
  },
};

let sender: EmailSender = consoleSender;

export function getEmailSender() {
  return sender;
}

export function setEmailSender(next: EmailSender) {
  sender = next;
}
