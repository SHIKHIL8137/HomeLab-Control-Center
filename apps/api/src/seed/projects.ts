import type { ProjectInput } from '@hlcc/shared';

/**
 * Registry entries taken from the infrastructure audit. Only facts that audit confirmed are set:
 * container names, compose directories and repositories. Health URLs are left null on purpose;
 * add them once the real endpoints are confirmed.
 */
export const SEED_PROJECTS: ProjectInput[] = [
  {
    id: 'devworkspace',
    name: 'DevWorkspace',
    description: 'Static marketing site served by nginx from release directories.',
    repoUrl: 'https://github.com/SHIKHIL8137/devworkspace_web',
    deploymentDir: '/srv/www/devworkspace',
    environment: 'production',
    desiredState: 'running',
    healthUrl: null,
    containers: ['devworkspace-nginx'],
    capabilities: ['monitor'],
  },
  {
    id: 'devconnect',
    name: 'DevConnect',
    description:
      'Microservice stack (backend repo; frontend is a separate repo). Currently stopped; desired state not yet confirmed.',
    repoUrl: 'https://github.com/SHIKHIL8137/DevConnect_BackEnd',
    deploymentDir: '/srv/projects/devconnect/deploy',
    environment: 'production',
    desiredState: 'unknown',
    healthUrl: null,
    containers: [
      'gateway-service',
      'auth-service',
      'user-service',
      'verification-service',
      'upload-service',
      'project-service',
      'complaint-service',
      'bidding-service',
      'socket-service',
      'chat-service',
      'payment-service',
      'devconnect-frontend',
      'devconnect-edge',
      'devconnect-redis',
      'devconnect-mongo',
      'devconnect-kafka',
    ],
    capabilities: ['monitor'],
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Self-hosted file storage with a PostgreSQL database.',
    repoUrl: null,
    deploymentDir: '/home/shikhil/nextcloud',
    environment: 'production',
    desiredState: 'running',
    healthUrl: null,
    containers: ['nextcloud', 'nextcloud-db'],
    capabilities: ['monitor'],
  },
  {
    id: 'homelab-control-center',
    name: 'HomeLab Control Center',
    description: 'This dashboard. Not deployed to the server yet.',
    repoUrl: 'https://github.com/SHIKHIL8137/HomeLab-Control-Center',
    deploymentDir: null,
    environment: 'production',
    desiredState: 'unknown',
    healthUrl: null,
    containers: [],
    capabilities: ['monitor'],
  },
];
