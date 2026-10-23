// Loaded with --import before every test file (test/helpers/test-tmp.mjs). The existing suite asserts
// the Chinese text the board has always shown, so tests run in zh-CN unless a test switches language
// itself. KANBAN_LANGUAGE does the same for command lines the tests spawn.
import { assertTestEnvironment } from "../../server/storage/test-safety";
import { setLanguage } from "../../shared/i18n";

assertTestEnvironment(process.env);
setLanguage("zh-CN");
