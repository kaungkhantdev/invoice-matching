import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** "ap-southeast-1" → "Singapore (ap-southeast-1)". */
export const regionName = (region: string) => (region === "ap-southeast-1" ? `Singapore (${region})` : region);

/** Settings that give the AWS SDK a login: keys, a profile, or a web-identity / container role. */
const LOGIN_SETTINGS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
];

/**
 * Is an AWS login set up here? (Bedrock and Textract both need one.) A quick local look only: whether it is
 * still valid (e.g. an expired SSO session) shows on the first read, with a plain-words error.
 */
export function awsLoginFound(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const fromEnv = LOGIN_SETTINGS.some((name) => Boolean(env[name]));
  return fromEnv || existsSync(join(home, ".aws", "credentials")) || existsSync(join(home, ".aws", "config"));
}
