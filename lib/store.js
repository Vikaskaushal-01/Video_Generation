// Storage: job records in Upstash Redis, video files in Vercel Blob.
import { Redis } from "@upstash/redis";
import { put, del } from "@vercel/blob";

// Vercel's Upstash integration sets KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const STORAGE_ERROR = !url || !token
  ? "Database not connected: in your Vercel project open Storage → add Upstash Redis, then redeploy."
  : !process.env.BLOB_READ_WRITE_TOKEN
    ? "Video storage not connected: in your Vercel project open Storage → add Blob, then redeploy."
    : null;

const redis = url && token ? new Redis({ url, token }) : null;
const INDEX = "jobs";
const key = (id) => `job:${id}`;

export async function getJob(id) {
  return (await redis.get(key(id))) || null;
}

export async function saveJob(job) {
  await redis.set(key(job.id), job);
}

export async function addJob(job) {
  await Promise.all([saveJob(job), redis.zadd(INDEX, { score: job.createdAt, member: job.id })]);
}

export async function listJobs(limit = 100) {
  const ids = await redis.zrange(INDEX, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  return (await redis.mget(...ids.map(key))).filter(Boolean);
}

