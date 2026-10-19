// The `hermes-serve` v2 kit (docker-sandboxes/kit/spec.yaml) packed into the artifact JSON the
// Sandboxes API takes inline at create. Copied from the Go-reference golden
// (docker-sandboxes/provisioner/tests/golden/hermes-serve.json); docker-sandboxes-kit.test.ts
// fails when the two drift. Regenerate after editing the kit: docker-sandboxes/tools/regenerate-goldens.sh,
// then copy the golden here.
export const HERMES_SERVE_KIT = {
  manifest: {
    schemaVersion: '2',
    kind: 'sandbox',
    name: 'hermes-serve',
    displayName: 'Hermes Agent backend',
    description:
      'Hermes Agent as a headless backend (`hermes serve`) for Hermes Desktop, with its state on a persistent volume',
    binary: '/usr/local/bin/hermes-start',
    template:
      'docker.io/sbxrundocker/hermes-serve-image@sha256:9fc680c3e08e6d51d9111b132bc1eda61862fdfa83821d0bada28d1123d572ed',
    aiFilename: 'AGENTS.md',
    runOptions: ['serve', '--host', '0.0.0.0', '--port', '9119'],
    interactiveOptions: ['serve', '--host', '0.0.0.0', '--port', '9119']
  },
  caps: {
    network: {
      allow: [
        'api.anthropic.com',
        'platform.claude.com',
        'api.openai.com',
        'openrouter.ai',
        '*.openrouter.ai',
        'models.dev',
        'opencode.ai',
        'github.com',
        'api.github.com',
        'raw.githubusercontent.com',
        'hermes-agent.nousresearch.com'
      ]
    }
  },
  credentials: [
    {
      service: 'anthropic',
      apiKey: {
        name: 'ANTHROPIC_API_KEY',
        proxyManaged: true,
        inject: [
          {
            domain: 'api.anthropic.com',
            header: 'x-api-key',
            format: '%s'
          }
        ]
      },
      oauth: {
        tokenEndpoint: {
          host: 'platform.claude.com',
          path: '/v1/oauth/token'
        },
        resourceHosts: ['api.anthropic.com'],
        sentinels: {
          accessToken: 'sk-ant-oat01-proxy-managed',
          refreshToken: 'sk-ant-ort01-proxy-managed'
        },
        credentialFile: {
          path: '~/.claude/.credentials.json',
          structure: {
            claudeAiOauth: {
              accessToken: '{{.AccessToken}}',
              expiresAt: '{{.ExpiresAt}}',
              refreshToken: '{{.RefreshToken}}',
              scopes: '{{.Scopes}}'
            }
          }
        }
      }
    },
    {
      service: 'openai',
      apiKey: {
        name: 'OPENAI_API_KEY',
        proxyManaged: true,
        inject: [
          {
            domain: 'api.openai.com',
            header: 'Authorization',
            format: 'Bearer %s'
          }
        ]
      }
    },
    {
      service: 'openrouter',
      apiKey: {
        name: 'OPENROUTER_API_KEY',
        proxyManaged: true,
        inject: [
          {
            domain: 'openrouter.ai',
            header: 'Authorization',
            format: 'Bearer %s'
          }
        ]
      }
    }
  ],
  environment: {
    variables: {
      HERMES_HOME: '/home/agent/.hermes',
      HERMES_INSTALL_ROOT: '/home/agent/.hermes-install',
      HERMES_RUNTIME_DIR: '/home/agent/.hermes-install/tools'
    }
  },
  commands: {
    startup: [
      {
        command: ['sh', '-c', 'chown agent:agent /home/agent/.hermes 2>/dev/null || true'],
        user: '0',
        description: 'Re-own the state volume mount root to agent'
      },
      {
        command: [
          'sh',
          '-c',
          'setsid sh -c \' export HOME=/home/agent HERMES_HOME=/home/agent/.hermes; while :; do if [ -e "$HERMES_HOME/installs" ] && [ -w "$HERMES_HOME" ]; then mkdir -p "$HERMES_HOME/logs"; ( [ -f "$HERMES_HOME/credential-auth.env" ] && . "$HERMES_HOME/credential-auth.env"; exec "$HOME/.local/bin/hermes" gateway run ) >>"$HERMES_HOME/logs/gateway-run.log" 2>&1 </dev/null; fi; sleep 5; done\' >/dev/null 2>&1 </dev/null &'
        ],
        user: '1000',
        background: true,
        description: 'Run the Hermes gateway that owns cron (restarted if it exits)'
      }
    ]
  }
} as const
