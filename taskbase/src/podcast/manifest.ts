/** 播客应用声明：节目列表采集与单节目同步。 */
export const PODCAST_APP_ID = 'podcast-tools';

const datePattern = '^\\d{4}-\\d{2}-\\d{2}$';
const dateSchema = { type: 'string', pattern: datePattern };

export const podcastManifest = {
  app_id: PODCAST_APP_ID,
  display_name: '播客工具',
  max_concurrency: 2,
  tasks: [
    {
      task_key: 'shows/collect',
      display_name: '采集节目列表',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          show_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
          show_urls: { type: 'array', items: { type: 'string', minLength: 1 } },
          since: dateSchema,
          until: dateSchema,
        },
      },
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['shows', 'inserted', 'updated'],
        properties: {
          shows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          inserted: { type: 'integer', minimum: 0 },
          updated: { type: 'integer', minimum: 0 },
          failed: { type: 'integer', minimum: 0 },
        },
      },
      queue_timeout_ms: 3_600_000,
      execution_timeout_ms: 3_600_000,
      max_attempts: 2,
      artifact_policy: { required: false },
      schedulable: false,
    },
    {
      task_key: 'show/sync',
      display_name: '同步单个节目',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['show_id'],
        properties: {
          show_id: { type: 'string', minLength: 1, maxLength: 100 },
          since: dateSchema,
          until: dateSchema,
        },
      },
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['shows', 'inserted', 'updated'],
        properties: {
          shows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          inserted: { type: 'integer', minimum: 0 },
          updated: { type: 'integer', minimum: 0 },
          failed: { type: 'integer', minimum: 0 },
        },
      },
      queue_timeout_ms: 3_600_000,
      execution_timeout_ms: 3_600_000,
      max_attempts: 2,
      artifact_policy: { required: false },
      schedulable: true,
    },
  ],
};
