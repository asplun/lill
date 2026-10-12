/** Core provider contracts shared by comments, notifications, and local media. */
import { basename } from 'node:path';

export function createCoreProviders({ mail, security, uploadDir }) {
  const media = Object.freeze({
    uploadDir: String(uploadDir || ''),
    publicUrl(fileName) {
      const name = basename(String(fileName || ''));
      return name ? '/uploads/' + name : '/uploads/';
    },
  });
  return Object.freeze({ mail, security, media });
}
