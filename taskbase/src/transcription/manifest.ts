/** 转写应用声明：输入一个公开音频 URL，输出文字稿和 Markdown 产物。 */
export const TRANSCRIPTION_APP_ID = 'transcription-tools';

export const transcriptionManifest = {
  app_id: TRANSCRIPTION_APP_ID,
  display_name: '转写工具',
  max_concurrency: 1,
  tasks: [
    {
      task_key: 'episode/transcribe',
      display_name: '转写单集',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['audio_url'],
        properties: {
          audio_url: { type: 'string', minLength: 1, maxLength: 5000 },
          episode_id: { type: 'string', minLength: 1, maxLength: 200 },
          show_id: { type: 'string', minLength: 1, maxLength: 200 },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          language: { type: 'string', minLength: 2, maxLength: 20 },
        },
      },
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['transcript_id', 'artifact_id', 'segments', 'language', 'duration_seconds', 'text'],
        properties: {
          transcript_id: { type: 'string', minLength: 1 },
          artifact_id: { type: 'string', minLength: 1 },
          segments: { type: 'array', items: { type: 'object', additionalProperties: true } },
          language: { type: 'string', minLength: 2, maxLength: 20 },
          duration_seconds: { type: 'number', minimum: 0 },
          text: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
      queue_timeout_ms: 3_600_000,
      execution_timeout_ms: 21_600_000,
      max_attempts: 2,
      artifact_policy: { required: true, max_bytes: 5_242_880 },
      schedulable: false,
    },
  ],
};
