import { defineConfig } from 'vite';

const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const owner = process.env.GITHUB_REPOSITORY?.split('/')[0];
const isUserSite = repo && owner && repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;

export default defineConfig({
  base: repo ? (isUserSite ? '/' : `/${repo}/`) : '/',
});
