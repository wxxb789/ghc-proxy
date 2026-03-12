#!/usr/bin/env bun

import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'

import { auth } from './auth'
import { checkUsage } from './check-usage'
import { debug } from './debug'
import { VERSION } from './lib/version'
import { start } from './start'

const main = defineCommand({
  meta: {
    name: 'ghc-proxy',
    version: VERSION,
    description:
      'A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.',
  },
  subCommands: { auth, start, 'check-usage': checkUsage, debug },
})

runMain(main).catch((error) => {
  consola.error('Failed to start CLI:', error)
  process.exitCode = 1
})
