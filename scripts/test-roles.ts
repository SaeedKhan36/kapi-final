import { buildRole, echoRole, handlerFor } from "../apps/agent/src/roles.ts";
import { equal, group, report, test, throws } from "./harness.ts";

group("agent role dispatch");

await test("known production roles resolve to their real implementation", () => {
  delete process.env.KAPI_TEST_ECHO_ROLE;
  equal(handlerFor("build"), buildRole, "build role");
});

await test("an unknown production role fails explicitly", async () => {
  delete process.env.KAPI_TEST_ECHO_ROLE;
  await throws(() => handlerFor("unknown-production-role"), "unknown role must not echo");
});

await test("the echo role is available only behind the test switch", () => {
  process.env.KAPI_TEST_ECHO_ROLE = "true";
  equal(handlerFor("unknown-test-role"), echoRole, "test bootstrap role");
  delete process.env.KAPI_TEST_ECHO_ROLE;
});

report();
