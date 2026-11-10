// `node --import ./tests/support/pi-packages.mjs --test tests/`: lets tests
// load modules that import pi (@mariozechner/*, typebox, ...) by resolving
// them from the installed pi release, as pi does when it loads the extension.
import { register } from "node:module";

register("./pi-resolve.mjs", import.meta.url);
