import { createSwaggerSpec } from 'next-swagger-doc';

export const getApiDocs = async () => {
  const spec = createSwaggerSpec({
    apiFolder: 'src/app/api', // Scans the app/api directory for JSDoc comments
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Next.js App Router API Docs',
        version: '1.0.0',
        description: 'Interactive API documentation built with Swagger',
      },
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [],
    },
  });
  return spec;
};