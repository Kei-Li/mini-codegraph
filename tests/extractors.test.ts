import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractJpaEntities, indexJpaEntities } from '../src/extraction/jpa-extractor.js'
import { extractSecurityAnnotations, indexSecurity } from '../src/extraction/security-extractor.js'
import { indexLombokAnnotations } from '../src/extraction/lombok-extractor.js'
import { indexAopAnnotations } from '../src/extraction/aop-extractor.js'
import { parseMyBatisXmlFile, findMyBatisMapperDir } from '../src/extraction/mybatis-extractor.js'
import { indexCacheAnnotations, parseCacheAnnotationValue, extractRedisConfig } from '../src/extraction/cache-extractor.js'
import { extractRedisHashes, extractRedisTemplate, extractRedisRepo, indexRedisAnnotations } from '../src/extraction/redis-extractor.js'
import { readFileSync } from 'node:fs'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}))

function createMockQueryManager(): any {
  const nodes: Map<string, any> = new Map()
  const annotations: any[] = []
  return {
    insertNode: vi.fn((n: any) => { nodes.set(n.id, { ...n }) }),
    insertAnnotation: vi.fn((nodeId: string, annotationName: string, value: string, line: number, moduleId: string) => {
      annotations.push({ nodeId, annotationName, value, line, moduleId })
    }),
    insertEdge: vi.fn(() => {}),
    searchNodes: vi.fn((query: string, limit = 10) => {
      const q = query.toLowerCase()
      return Array.from(nodes.values()).filter(n =>
        n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
      ).slice(0, limit)
    }),
    getNode: vi.fn((id: string) => nodes.get(id)),
    getAllNodes: vi.fn(() => Array.from(nodes.values())),
    getAnnotationsByNode: vi.fn((nodeId: string) => {
      return annotations.filter(a => a.nodeId === nodeId)
    }),
    getChildren: vi.fn((parentId: string) => {
      return Array.from(nodes.values()).filter(n => n.parentId === parentId)
    }),
    getNodesByAnnotation: vi.fn((annName: string) => {
      const ids = annotations.filter(a => a.annotationName === annName).map(a => a.nodeId)
      return Array.from(nodes.values()).filter(n => ids.includes(n.id))
    }),
    getNodesByFile: vi.fn(() => []),
    _nodes: nodes,
    _annotations: annotations,
  }
}

describe('JPA Extractor', () => {
  describe('extractJpaEntities', () => {
    it('extracts @Entity with @Table mapping', () => {
      const source = `@Entity
@Table(name = "users")
public class User {
  @Column(name = "user_id")
  private Long id;
  @Column(name = "user_name", nullable = false)
  private String name;
  @OneToMany(mappedBy = "user")
  private List<Order> orders;
}`
      const entities = extractJpaEntities(source, 'User.java')
      expect(entities).toHaveLength(1)
      expect(entities[0].className).toBe('User')
      expect(entities[0].tableName).toBe('users')
      expect(entities[0].columns).toHaveLength(2)
      expect(entities[0].columns[0].name).toBe('user_id')
      expect(entities[0].columns[1].nullable).toBe(false)
      expect(entities[0].relationships).toHaveLength(1)
      expect(entities[0].relationships[0].type).toBe('OneToMany')
    })

    it('returns empty when no @Entity annotation', () => {
      const source = 'public class NotAnEntity { private String name; }'
      expect(extractJpaEntities(source, 'Test.java')).toEqual([])
    })

    it('handles @MappedSuperclass with columns', () => {
      const source = `@MappedSuperclass
public abstract class BaseEntity {
  @Column(name = "id")
  private Long id;
}`
      const entities = extractJpaEntities(source, 'BaseEntity.java')
      expect(entities).toHaveLength(1)
      expect(entities[0].className).toBe('BaseEntity')
    })

    it('extracts ManyToOne relationship with non-generic target', () => {
      const source = `@Entity
public class Order {
  @ManyToOne(fetch = LAZY)
  private User user;
}`
      const entities = extractJpaEntities(source, 'Order.java')
      expect(entities).toHaveLength(1)
      expect(entities[0].relationships[0].type).toBe('ManyToOne')
      expect(entities[0].relationships[0].targetEntity).toBe('User')
    })

    it('returns empty if no class declaration found', () => {
      const source = '@Entity\n// no class'
      expect(extractJpaEntities(source, 'Test.java')).toEqual([])
    })
  })

  describe('indexJpaEntities', () => {
    it('inserts entity node and edges for class with columns', () => {
      const qm = createMockQueryManager()
      qm.insertNode({
        id: 'Product.java:Product', kind: 'class', name: 'Product',
        qualifiedName: 'com.app.Product', filePath: 'Product.java',
        language: 'java', startLine: 1, endLine: 10, startColumn: 0, endColumn: 0,
        docstring: '', signature: '', visibility: 'public',
        isExported: false, parentId: null, moduleId: 'mod1',
      })
      const source = `@Entity
@Table(name = "products")
public class Product {
  @Column(name = "product_name")
  private String name;
}`
      const result = indexJpaEntities(qm, source, 'Product.java', 'mod1')
      expect(result).toHaveLength(1)
      expect(qm.getNode('jpa:Product')).toBeDefined()
      expect(qm._annotations.length).toBeGreaterThanOrEqual(1)
    })

    it('returns empty array when no entity found', () => {
      const qm = createMockQueryManager()
      const result = indexJpaEntities(qm, 'public class Plain { }', 'Plain.java', 'mod1')
      expect(result).toEqual([])
    })
  })
})

describe('Security Extractor', () => {
  describe('extractSecurityAnnotations', () => {
    it('extracts @PreAuthorize', () => {
      const source = `@PreAuthorize("hasRole('ADMIN')")
public void adminOnly() { }`
      const results = extractSecurityAnnotations(source, 'AdminController.java', 'mod1')
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].annotationName).toBe('PreAuthorize')
      expect(results[0].value).toContain('ADMIN')
    })

    it('extracts @Secured', () => {
      const source = `@Secured("ROLE_USER")
public void userOnly() { }`
      const results = extractSecurityAnnotations(source, 'UserController.java', 'mod1')
      expect(results.some(r => r.annotationName === 'Secured')).toBe(true)
    })

    it('returns empty for source without security annotations', () => {
      const source = 'public class Plain { }'
      expect(extractSecurityAnnotations(source, 'Plain.java', 'mod1')).toEqual([])
    })
  })

  describe('indexSecurity', () => {
    it('inserts edges and annotations for found annotations', () => {
      const qm = createMockQueryManager()
      // extractSecurityAnnotations finds the first (\w+) before \( on any nearby line
      // On the annotation line it matches "PreAuthorize", so nodeId = AdminController.java:PreAuthorize:1
      const nodeId = 'AdminController.java:PreAuthorize:1'
      qm.insertNode({
        id: nodeId, kind: 'method', name: 'PreAuthorize',
        qualifiedName: 'com.app.AdminController.adminOnly', filePath: 'AdminController.java',
        language: 'java', startLine: 2, endLine: 2, startColumn: 0, endColumn: 0,
        docstring: '', signature: '', visibility: 'public',
        isExported: false, parentId: null, moduleId: 'mod1',
      })
      const source = `@PreAuthorize("hasRole('ADMIN')")
public void adminOnly() { }`
      indexSecurity(qm, source, 'AdminController.java', 'mod1')
      expect(qm._annotations.length).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('Lombok Extractor', () => {
  function setupWithClass(qm: any, className: string, filePath: string, moduleId: string) {
    const nodeId = `${filePath}:${className}`
    qm.insertNode({
      id: nodeId, kind: 'class', name: className,
      qualifiedName: `com.app.${className}`, filePath,
      language: 'java', startLine: 3, endLine: 20, startColumn: 0, endColumn: 0,
      docstring: '', signature: '', visibility: 'public',
      isExported: false, parentId: null, moduleId,
    })
    return nodeId
  }

  it('generates getters/setters for @Data class', () => {
    const qm = createMockQueryManager()
    setupWithClass(qm, 'User', 'User.java', 'mod1')
    const source = `@Data
public class User {
  private String name;
  private int age;
}`
    const result = indexLombokAnnotations(qm, source, 'User.java', 'mod1')
    expect(result.synthesizedNodes).toBeGreaterThan(0)
    expect(result.synthesizedEdges).toBeGreaterThan(0)
  })

  it('skips classes without Lombok annotations', () => {
    const qm = createMockQueryManager()
    setupWithClass(qm, 'Plain', 'Plain.java', 'mod1')
    const source = 'public class Plain { private String x; }'
    const result = indexLombokAnnotations(qm, source, 'Plain.java', 'mod1')
    expect(result.synthesizedNodes).toBe(0)
  })

  it('handles @Builder annotation', () => {
    const qm = createMockQueryManager()
    setupWithClass(qm, 'Config', 'Config.java', 'mod1')
    const source = `@Builder
public class Config {
  private String host;
  private int port;
}`
    const result = indexLombokAnnotations(qm, source, 'Config.java', 'mod1')
    expect(result.synthesizedNodes).toBeGreaterThan(0)
  })
})

describe('AOP Extractor', () => {
  function setupWithAspectClass(qm: any, className: string, filePath: string, moduleId: string) {
    qm.insertNode({
      id: `${filePath}:${className}`, kind: 'class', name: className,
      qualifiedName: `com.app.${className}`, filePath,
      language: 'java', startLine: 1, endLine: 20, startColumn: 0, endColumn: 0,
      docstring: '', signature: '', visibility: 'public',
      isExported: false, parentId: null, moduleId,
    })
  }

  it('extracts @Before advice', () => {
    const qm = createMockQueryManager()
    setupWithAspectClass(qm, 'LoggingAspect', 'LoggingAspect.java', 'mod1')
    const source = `@Aspect
public class LoggingAspect {
  @Before("execution(* com.app.service.*.*(..))")
  public void logBefore() { }
}`
    const result = indexAopAnnotations(qm, source, 'LoggingAspect.java', 'mod1')
    expect(result.advices.length).toBeGreaterThanOrEqual(1)
    expect(result.advices[0].adviceType).toBe('Before')
  })

  it('extracts @Pointcut with method name', () => {
    const qm = createMockQueryManager()
    setupWithAspectClass(qm, 'SecurityAspect', 'SecurityAspect.java', 'mod1')
    const source = `@Aspect
public class SecurityAspect {
  @Pointcut("execution(* com.app..*.*(..))")
  public void allMethods() { }
}`
    const result = indexAopAnnotations(qm, source, 'SecurityAspect.java', 'mod1')
    expect(result.pointcuts.length).toBeGreaterThanOrEqual(1)
    expect(result.pointcuts[0].pointcutName).toBe('allMethods')
  })

  it('returns empty for non-aspect class', () => {
    const qm = createMockQueryManager()
    const source = 'public class Plain { public void foo() { } }'
    const result = indexAopAnnotations(qm, source, 'Plain.java', 'mod1')
    expect(result.advices).toEqual([])
    expect(result.pointcuts).toEqual([])
  })
})

describe('MyBatis Extractor', () => {
  const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.app.mapper.UserMapper">
  <select id="findById" parameterType="long" resultType="com.app.model.User">
    SELECT * FROM users WHERE id = #{id}
  </select>
  <insert id="insert" parameterType="com.app.model.User">
    INSERT INTO users (name) VALUES (#{name})
  </insert>
  <update id="updateName" parameterType="map">
    UPDATE users SET name = #{name} WHERE id = #{id}
  </update>
  <delete id="deleteById">
    DELETE FROM users WHERE id = #{id}
  </delete>
</mapper>`

  beforeEach(() => {
    vi.mocked(readFileSync).mockReset()
  })

  it('parses XML with select/insert/update/delete', () => {
    vi.mocked(readFileSync).mockReturnValue(xmlContent)
    const result = parseMyBatisXmlFile('/project/mappers/UserMapper.xml', '/project')
    expect(result.mappings).toHaveLength(4)
    expect(result.mappings[0].namespace).toBe('com.app.mapper.UserMapper')
    expect(result.mappings[0].id).toBe('findById')
    expect(result.mappings[0].statementType).toBe('select')
    expect(result.mappings[1].statementType).toBe('insert')
    expect(result.mappings[2].statementType).toBe('update')
    expect(result.mappings[3].statementType).toBe('delete')
  })

  it('handles XML without namespace', () => {
    vi.mocked(readFileSync).mockReturnValue('<mapper><select id="test">SELECT 1</select></mapper>')
    const result = parseMyBatisXmlFile('/project/test.xml', '/project')
    expect(result.mappings).toEqual([])
  })

  it('handles file read errors', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('file not found') })
    const result = parseMyBatisXmlFile('/project/nonexistent.xml', '/project')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.mappings).toEqual([])
  })
})

describe('Cache Extractor', () => {
  describe('parseCacheAnnotationValue', () => {
    it('parses cache names from value attribute', () => {
      const result = parseCacheAnnotationValue('Cacheable', '@Cacheable(value = "users")')
      expect(result.cacheNames).toEqual(['users'])
    })

    it('parses key and condition', () => {
      const result = parseCacheAnnotationValue('CacheEvict',
        '@CacheEvict(value = "sessions", key = "#sessionId", condition = "#sessionId != null")')
      expect(result.cacheNames).toEqual(['sessions'])
      expect(result.key).toBe('#sessionId')
      expect(result.condition).toContain('sessionId')
    })

    it('returns defaults for empty value', () => {
      const result = parseCacheAnnotationValue('Cacheable', '')
      expect(result.cacheNames).toEqual([])
      expect(result.key).toBe('')
    })
  })

  describe('indexCacheAnnotations', () => {
    it('processes cache annotations from DB nodes', () => {
      const qm = createMockQueryManager()
      qm.insertNode({
        id: 'UserService.java:findById', kind: 'method', name: 'findById',
        qualifiedName: 'com.app.UserService.findById', filePath: 'UserService.java',
        language: 'java', startLine: 5, endLine: 10, startColumn: 0, endColumn: 0,
        docstring: '', signature: '', visibility: 'public',
        isExported: false, parentId: null, moduleId: 'mod1',
      })
      qm.insertAnnotation('UserService.java:findById', 'Cacheable', 'value = "users"', 5, 'mod1')
      const result = indexCacheAnnotations(qm, '/project', 'mod1')
      expect(result.annotations.length).toBeGreaterThanOrEqual(1)
      expect(result.annotations[0].type).toBe('Cacheable')
    })

    it('returns empty for project without cache annotations', () => {
      const qm = createMockQueryManager()
      const result = indexCacheAnnotations(qm, '/project', 'mod1')
      expect(result.annotations).toEqual([])
    })
  })

  describe('extractRedisConfig', () => {
    it('returns undefined when no config file exists', () => {
      const result = extractRedisConfig('/nonexistent')
      expect(result).toBeUndefined()
    })
  })
})

describe('Redis Extractor', () => {
  describe('extractRedisHashes', () => {
    it('extracts @RedisHash with class name', () => {
      const source = `@RedisHash("users")
public class User {
  @Id
  private String id;
  @Indexed
  private String name;
}`
      const hashes = extractRedisHashes(source, 'User.java')
      expect(hashes).toHaveLength(1)
      expect(hashes[0].className).toBe('User')
      expect(hashes[0].redisKey).toBe('users')
      expect(hashes[0].fields.length).toBeGreaterThanOrEqual(1)
    })

    it('returns empty when no @RedisHash', () => {
      const source = 'public class Plain { }'
      expect(extractRedisHashes(source, 'Plain.java')).toEqual([])
    })
  })

  describe('extractRedisTemplate', () => {
    it('detects RedisTemplate usage without generics', () => {
      const source = `public class UserService {
  private RedisTemplate redisTemplate;
  public void save() {
    redisTemplate.opsForValue().set("user:1", data);
  }
}`
      const result = extractRedisTemplate(source, 'UserService.java')
      expect(result).not.toBeNull()
      expect(result!.className).toBe('UserService')
      expect(result!.operations).toContain('opsForValue')
    })

    it('returns null when no RedisTemplate field', () => {
      const source = 'public class Plain { }'
      expect(extractRedisTemplate(source, 'Plain.java')).toBeNull()
    })
  })

  describe('extractRedisRepo', () => {
    it('detects CrudRepository extension', () => {
      const source = `public interface UserRepository extends CrudRepository<User, String> {
  User findByName(String name);
}`
      const result = extractRedisRepo(source, 'UserRepository.java')
      expect(result).not.toBeNull()
      expect(result!.className).toBe('UserRepository')
      expect(result!.entityClass).toBe('User')
    })

    it('returns null for non-repository interface', () => {
      const source = 'public interface Plain { }'
      expect(extractRedisRepo(source, 'Plain.java')).toBeNull()
    })
  })

  describe('indexRedisAnnotations', () => {
    it('inserts nodes for @RedisHash', () => {
      const qm = createMockQueryManager()
      const source = `@RedisHash("users")
public class User {
  @Id
  private String id;
}`
      const result = indexRedisAnnotations(qm, source, 'User.java', 'mod1')
      expect(result.hashes).toHaveLength(1)
      expect(qm.getNode('redis:hash:User.java:User')).toBeDefined()
    })

    it('inserts nodes for RedisTemplate (without generics)', () => {
      const qm = createMockQueryManager()
      const source = `public class CacheService {
  private RedisTemplate redisTemplate;
}`
      const result = indexRedisAnnotations(qm, source, 'CacheService.java', 'mod1')
      expect(result.templates).toHaveLength(1)
      expect(result.templates[0].className).toBe('CacheService')
    })
  })
})
