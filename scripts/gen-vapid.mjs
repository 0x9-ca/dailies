#!/usr/bin/env node
// Prints a new VAPID key pair (P-256) in the base64url formats the Worker expects.
import { webcrypto as crypto } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey)); // 65-byte uncompressed point
const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d; // 32-byte scalar

console.log(`VAPID_PUBLIC_KEY=${pub}`);
console.log(`VAPID_PRIVATE_KEY=${priv}`);
console.log("\nVAPID_PUBLIC_KEY and VAPID_SUBJECT (mailto: or https URL) are vars; VAPID_PRIVATE_KEY is a secret:");
console.log("  npx wrangler secret put VAPID_PRIVATE_KEY --env <staging|production>");
