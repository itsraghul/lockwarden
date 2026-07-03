#!/usr/bin/env node
// lock-warden is an alias that exists so the natural mistyping of
// `npx lockwarden` can never be claimed by someone else's code.
// The real CLI is the `lockwarden` package; importing its bin runs it.
import 'lockwarden/dist/index.js';
