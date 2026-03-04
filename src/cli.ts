#!/usr/bin/env node
import { createRequire } from "node:module"
import { Command } from "commander"
import { checkCommand } from "./commands/check.js"
import { lockCommand } from "./commands/lock.js"
import { initCommand } from "./commands/init.js"
import { newCommand } from "./commands/new.js"
import { setupCommand } from "./commands/setup.js"
import { loginCommand } from "./commands/login.js"
import { publishCommand } from "./commands/publish.js"
import { writeCommand } from "./commands/write.js"
import { pushCommand } from "./commands/push.js"
import { verifyCommand } from "./commands/verify.js"
import { migrateCommand } from "./commands/migrate.js"

const require = createRequire(import.meta.url)
const { version } = require("../package.json") as { version: string }

const program = new Command()

program
  .name("canon")
  .description("Canon worldbuilding CLI — scaffold, validate, and manage shared fiction universes")
  .version(version)

program.addCommand(setupCommand)
program.addCommand(loginCommand)
program.addCommand(publishCommand)
program.addCommand(checkCommand)
program.addCommand(lockCommand)
program.addCommand(initCommand)
program.addCommand(newCommand)
program.addCommand(writeCommand)
program.addCommand(pushCommand)
program.addCommand(verifyCommand)
program.addCommand(migrateCommand)

program.parse()
