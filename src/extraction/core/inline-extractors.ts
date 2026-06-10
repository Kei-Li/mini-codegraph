import type { QueryManager } from '../../db/queries.js'
import { shouldRunExtractor, sourceHasKeywords, sourceIncludesAny } from './extractor-guards.js'
import { indexJpaEntities } from '../data/jpa-extractor.js'
import { indexLombokAnnotations } from '../data/lombok-extractor.js'
import { indexMapStructMappers } from '../data/mapstruct-extractor.js'
import { indexGraphQLEndpoints } from '../middleware/graphql-extractor.js'
import { indexWebSocketEndpoints } from '../middleware/websocket-extractor.js'
import { indexTestAnnotations } from '../infra/test-extractor.js'
import { indexJpaCustomQueries } from '../data/jpa-query-extractor.js'
import { indexRedisAnnotations } from '../data/redis-extractor.js'
import { indexR2dbcEntities } from '../data/r2dbc-extractor.js'
import { indexJooqUsage } from '../data/jooq-extractor.js'
import { indexMongoEntities } from '../data/mongo-extractor.js'
import { indexSQLStatements } from '../data/sql-extractor.js'
import {
  indexSecurity, indexResilience, indexAsyncAnnotations,
  indexAopAnnotations, indexSecurityFilterChains, indexControllerAdvice,
  indexInterceptors, indexProfileAnnotations, indexHttpExchanges,
} from '../frameworks/spring-web-extractor.js'
import {
  indexObservationAnnotations, indexSpringIntegration, indexStreamFunctions,
} from '../frameworks/spring-cloud-extractor.js'
import {
  indexBatchJobs, indexSpringLdap, indexSpringSession,
} from '../frameworks/spring-misc-extractor.js'

export function runInlineExtractors(
  queries: QueryManager,
  source: string,
  relPath: string,
  moduleId: string,
  projectRoot: string,
  langName: string,
  fastMode: boolean
): void {
  if (fastMode) return
  if (langName !== 'java' && langName !== 'kotlin') return
  if (!sourceHasKeywords(source)) return

  if (shouldRunExtractor(source, 'jpa')) indexJpaEntities(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'security')) indexSecurity(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'batch')) indexBatchJobs(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'resilience')) indexResilience(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'lombok')) indexLombokAnnotations(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'mapstruct')) indexMapStructMappers(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'graphql')) indexGraphQLEndpoints(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'websocket')) indexWebSocketEndpoints(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'test')) indexTestAnnotations(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'async')) indexAsyncAnnotations(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'aop')) indexAopAnnotations(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'securityFilter')) indexSecurityFilterChains(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'controllerAdvice')) indexControllerAdvice(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'interceptor')) indexInterceptors(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'jpaQuery')) indexJpaCustomQueries(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'profile')) indexProfileAnnotations(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'redis')) indexRedisAnnotations(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'observability')) indexObservationAnnotations(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'httpExchange')) indexHttpExchanges(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'springIntegration')) indexSpringIntegration(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'springLdap')) indexSpringLdap(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'springSession')) indexSpringSession(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'r2dbc')) indexR2dbcEntities(queries, source, relPath, moduleId)
  if (shouldRunExtractor(source, 'jooq')) indexJooqUsage(queries, source, relPath, moduleId)
  if (sourceIncludesAny(source, ['StreamBridge', 'Function<', 'Supplier<', 'Consumer<', 'java.util.function'])) {
    indexStreamFunctions(queries, source, relPath, moduleId, projectRoot)
  }
  if (sourceIncludesAny(source, ['Mongo', 'mongo', 'Document', 'mongodb'])) {
    indexMongoEntities(queries, source, relPath, moduleId)
  }
  if (sourceIncludesAny(source, ['sql', 'SQL', 'Sql', 'jdbc', 'Jdbc', 'PreparedStatement', 'ResultSet', 'Connection', 'DataSource'])) {
    indexSQLStatements(queries, source, relPath, moduleId)
  }
}
