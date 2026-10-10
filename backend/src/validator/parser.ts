import { ChatCompletionRequest, ChatMessage } from '../types/openai.js';

export class FallbackContextBuilder {
  /**
   * Packages error feedback and original context for silent escalation to plus/pro/ultra
   */
  public static buildEscalationRequest(
    originalRequest: ChatCompletionRequest,
    failedOutput: string,
    validationError: string,
    targetModel: string
  ): ChatCompletionRequest {
    const updatedMessages: ChatMessage[] = [...originalRequest.messages];

    // Append the failed assistant attempt
    updatedMessages.push({
      role: 'assistant',
      content: failedOutput,
    });

    // Append system correction instruction
    updatedMessages.push({
      role: 'user',
      content: `[System Assertion Error] The previous output failed structural validation:\n${validationError}\n\nPlease regenerate the response. Ensure strict compliance with the required schema and ensure output is completely valid without syntax or schema violations.`,
    });

    return {
      ...originalRequest,
      model: targetModel,
      messages: updatedMessages,
      temperature: 0.1, // Lower temperature to increase determinism on retry
    };
  }
}
