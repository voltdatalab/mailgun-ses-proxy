import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/v1/send/route'
import { sendSystemMail } from '@/service/transaction-email-service'
import { NextRequest } from 'next/server'

const { log } = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return { log }
})
vi.mock('@/lib/core/logger', () => ({ default: log }))

// Mock the service
vi.mocked(sendSystemMail).mockImplementation(vi.fn())

describe('/v1/send POST', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should successfully send a system email', async () => {
    // Arrange
    const emailPayload = {
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    vi.mocked(sendSystemMail).mockResolvedValue({
      messageId: 'msg-123',
      dbId: 'db-123',
    })

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(200)
    expect(result).toEqual({
      success: true,
      timestamp: result.timestamp,
      data: {
        messageId: 'msg-123',
        recipients: 1,
        status: "sent",
      },
      message: 'Operation completed successfully',
    })
    expect(sendSystemMail).toHaveBeenCalledWith({
      from: 'system@example.com',
      replyTo: 'system@example.com',
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    })
  })

  it('should use provided from address', async () => {
    // Arrange
    const emailPayload = {
      from: 'custom@example.com',
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    vi.mocked(sendSystemMail).mockResolvedValue({
      messageId: 'msg-123',
      dbId: 'db-123',
    })

    // Act
    await POST(mockRequest)

    // Assert
    expect(sendSystemMail).toHaveBeenCalledWith({
      from: 'custom@example.com',
      replyTo: 'custom@example.com',
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    })
  })

  it('should use provided replyTo address', async () => {
    // Arrange
    const emailPayload = {
      from: 'sender@example.com',
      replyTo: 'reply@example.com',
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    vi.mocked(sendSystemMail).mockResolvedValue({
      messageId: 'msg-123',
      dbId: 'db-123',
    })

    // Act
    await POST(mockRequest)

    // Assert
    expect(sendSystemMail).toHaveBeenCalledWith({
      from: 'sender@example.com',
      replyTo: 'reply@example.com',
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    })
  })

  it('should return validation error for missing to field', async () => {
    // Arrange
    const emailPayload = {
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(400)
    expect(result).toEqual({
      success: false,
      error: 'Validation Error',
      message: "Validation failed: 'to': Invalid input: expected array, received undefined",
      timestamp: expect.any(String),
    })
    expect(sendSystemMail).not.toHaveBeenCalled()
  })

  it('should return validation error for empty to array', async () => {
    // Arrange
    const emailPayload = {
      to: [],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(400)
    expect(result).toEqual({
      success: false,
      error: 'Validation Error',
      message: "Validation failed: 'to': Too small: expected array to have >=1 items",
      timestamp: expect.any(String),
    })
  })

  it('should return validation error for missing subject', async () => {
    // Arrange
    const emailPayload = {
      to: ['recipient@example.com'],
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(400)
    expect(result.message).toContain("'subject'")
  })

  it('should return validation error for missing html', async () => {
    // Arrange
    const emailPayload = {
      to: ['recipient@example.com'],
      subject: 'Test Subject',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(400)
    expect(result.message).toContain("'html'")
  })

  it('should return validation error with multiple missing fields', async () => {
    // Arrange
    const emailPayload = {}

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(400)
    expect(result.message).toContain("Validation failed: 'to': Invalid input: expected array, received undefined; 'subject': Invalid input: expected string, received undefined; 'html': Invalid input: expected string, received undefined")
  })

  it('returns a generic retryable response and bounded log class for hostile service errors', async () => {
    // Arrange
    const emailPayload = {
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    const serviceError = new Error('SES service unavailable: recipient@example.test')
    serviceError.name = 'SES/Internal Error! ' + 'A'.repeat(65)
    vi.mocked(sendSystemMail).mockRejectedValue(serviceError)

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(500)
    expect(result).toHaveProperty("timestamp")
    delete result.timestamp
    expect(result).toEqual({
      success: false,
      error: 'Internal Server Error',
      message: 'Unable to send email. Please retry.',
    })
    expect(JSON.stringify(result)).not.toContain('recipient@example.test')
    expect(log.error).toHaveBeenCalledWith({ errorClass: 'Error' }, 'Failed to process system email')
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('recipient@example.test')
  })

  it('should handle JSON parsing errors', async () => {
    // Arrange
    const mockRequest = {
      json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
    } as unknown as NextRequest

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(500)
    expect(result).toEqual({
      success: false,
      error: 'Internal Server Error',
      message: 'Unable to send email. Please retry.',
      timestamp: result.timestamp
    })
  })

  it('should handle multiple recipients', async () => {
    // Arrange
    const emailPayload = {
      to: ['recipient1@example.com', 'recipient2@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    vi.mocked(sendSystemMail).mockResolvedValue({
      messageId: 'msg-123',
      dbId: 'db-123',
    })

    // Act
    const response = await POST(mockRequest)

    // Assert
    expect(response.status).toBe(200)
    expect(sendSystemMail).toHaveBeenCalledWith({
      from: 'system@example.com',
      replyTo: 'system@example.com',
      to: ['recipient1@example.com', 'recipient2@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    })
  })

  it('should handle non-Error exceptions', async () => {
    // Arrange
    const emailPayload = {
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      html: '<p>Test HTML content</p>',
    }

    const mockRequest = {
      json: vi.fn().mockResolvedValue(emailPayload),
    } as unknown as NextRequest

    vi.mocked(sendSystemMail).mockRejectedValue('String error')

    // Act
    const response = await POST(mockRequest)
    const result = await response.json()

    // Assert
    expect(response.status).toBe(500)
    expect(result.success).toBe(false) 
    expect(result.error).toBe("Internal Server Error")
    expect(result.message).toBe("Unable to send email. Please retry.")
  })
})