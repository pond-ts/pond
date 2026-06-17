import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: { name: '@storybook/react-vite', options: {} },
  addons: [],
  // No anonymous usage telemetry / no network calls from CI builds.
  core: { disableTelemetry: true },
};

export default config;
