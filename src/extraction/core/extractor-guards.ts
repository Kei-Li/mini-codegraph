export function sourceIncludesAny(source: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (source.includes(kw)) return true
  }
  return false
}

export const EXTRACTOR_GUARDS: Record<string, string[]> = {
  jpa: ['@Entity', '@Table(', '@Column(', '@Id', '@GeneratedValue', '@ManyToOne', '@OneToMany', '@JoinColumn', '@JoinTable'],
  security: ['@PreAuthorize', '@Secured', '@RolesAllowed', '@WithMockUser'],
  batch: ['@EnableBatchProcessing', '@JobScope', '@StepScope'],
  resilience: ['@CircuitBreaker', '@Retry', '@Bulkhead', '@RateLimiter', '@TimeLimiter'],
  lombok: ['@Data', '@Getter', '@Setter', '@AllArgsConstructor', '@NoArgsConstructor', '@Builder', '@Slf4j', '@Log4j', '@Value', '@ToString', '@EqualsAndHashCode'],
  mapstruct: ['@Mapper', '@Mapping'],
  graphql: ['@QueryMapping', '@MutationMapping', '@SchemaMapping', '@GraphQlController', '@GraphQl'],
  websocket: ['@MessageController', '@MessageMapping', '@SendToUser'],
  test: ['@Test', '@SpringBootTest', '@MockBean', '@InjectMocks', '@BeforeEach', '@BeforeAll', '@ExtendWith'],
  async: ['@Async', '@EnableAsync', '@Scheduled', '@EnableScheduling', 'org.jobrunr', '@Recurring'],
  aop: ['@Aspect', '@Pointcut', '@Around', '@Before(', '@After(', '@AfterReturning', '@AfterThrowing'],
  securityFilter: ['@SecurityFilterChain', '@WebSecurityConfigurer'],
  controllerAdvice: ['@ControllerAdvice', '@RestControllerAdvice', '@ExceptionHandler'],
  interceptor: ['@Interceptor', '@HandlerInterceptor', '@WebMvcConfigurer'],
  jpaQuery: ['@Query(', '@NamedQuery', '@NamedNativeQuery', '@Modifying'],
  profile: ['@Profile', '@Conditional(', '@ConditionalOnProperty'],
  redis: ['@RedisHash', '@Cacheable', '@CacheEvict', '@CachePut', '@Caching'],
  observability: ['@Observed', '@Observation', '@Timed', '@Counted', '@SpanTag', 'ObservationRegistry', 'micrometer-tracing'],
  httpExchange: ['@HttpExchange', '@GetExchange', '@PostExchange', '@PutExchange', '@DeleteExchange', '@PatchExchange'],
  springIntegration: ['@MessageEndpoint', '@ServiceActivator', '@Router', '@Splitter', '@Aggregator', '@Transformer', '@Filter', '@InboundChannelAdapter', '@OutboundChannelAdapter', '@BridgeFrom', '@BridgeTo'],
  springLdap: ['@Entry(', '@LdapRepository', 'ldapTemplate'],
  springSession: ['@EnableRedisHttpSession', '@EnableJdbcHttpSession', '@EnableMongoHttpSession', '@EnableHazelcastHttpSession'],
  r2dbc: ['org.springframework.data.r2dbc', 'org.springframework.data.relational', 'DatabaseClient', 'R2dbcRepository'],
  jooq: ['org.jooq', 'DSLContext', 'DSL.', 'jooq'],
}

export const ALL_EXTRACTOR_KEYWORDS: string[] = [
  ...new Set([
    ...Object.values(EXTRACTOR_GUARDS).flat(),
    'StreamBridge', 'Function<', 'Supplier<', 'Consumer<', 'java.util.function',
    'Mongo', 'mongo', 'Document', 'mongodb',
    'sql', 'SQL', 'Sql', 'jdbc', 'Jdbc', 'PreparedStatement', 'ResultSet', 'Connection', 'DataSource',
    'org.jooq', 'DSLContext', 'DSL.', 'jooq',
  ]),
]

export const EXTRACTOR_KEYWORDS_RE = new RegExp(
  ALL_EXTRACTOR_KEYWORDS.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
)

export function sourceHasKeywords(source: string): boolean {
  return EXTRACTOR_KEYWORDS_RE.test(source)
}

export function shouldRunExtractor(source: string, name: string): boolean {
  const keywords = EXTRACTOR_GUARDS[name]
  if (!keywords) return true
  return sourceIncludesAny(source, keywords)
}
