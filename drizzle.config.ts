import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/dockflow.db'
  }
  //dbCredentials: {
  //  url: process.env.DATABASE_URL!, // "url": "postgresql://ap_admin:ap_secret@127.0.0.1:5432/workflow"
  //},
});
