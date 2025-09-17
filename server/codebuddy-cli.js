import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import sessionManager from './sessionManager.js';

let activeCodeBuddyProcesses = new Map(); // Track active processes by session ID

async function spawnCodeBuddy(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode, images } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    let fullResponse = ''; // Accumulate the full response
    
    // Process images if provided
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };
    
    // Build CodeBuddy CLI command
    const args = [];
    
    // Add prompt flag with command if we have a command
    if (command && command.trim()) {
      // If we have a sessionId, include conversation history
      if (sessionId) {
        const context = sessionManager.buildConversationContext(sessionId);
        if (context) {
          // Combine context with current command
          const fullPrompt = context + command;
          args.push(fullPrompt); // CodeBuddy CLI uses direct prompt argument
        } else {
          args.push(command);
        }
      } else {
        args.push(command);
      }
    }
    
    // Use cwd (actual project directory)
    const cleanPath = (cwd || process.cwd()).replace(/[^\x20-\x7E]/g, '').trim();
    const workingDir = cleanPath;
    
    // Handle images by saving them to temporary files
    const tempImagePaths = [];
    let tempDir = null;
    if (images && images.length > 0) {
      try {
        // Create temp directory in the project directory
        tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
        await fs.mkdir(tempDir, { recursive: true });
        
        // Save each image to a temp file
        for (const [index, image] of images.entries()) {
          const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) continue;
          
          const [, mimeType, base64Data] = matches;
          const extension = mimeType.split('/')[1] || 'png';
          const filename = `image_${index}.${extension}`;
          const filepath = path.join(tempDir, filename);
          
          await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
          tempImagePaths.push(filepath);
        }
        
        // Include image paths in the prompt for CodeBuddy to reference
        if (tempImagePaths.length > 0 && command && command.trim()) {
          const imageNote = `\n\n[已添加图片: 有${tempImagePaths.length}张图片。它们保存在以下路径:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
          
          // Update the command in args
          if (args.length > 0) {
            args[0] += imageNote;
          }
        }
        
      } catch (error) {
        // Error handling for image processing
      }
    }
    
    // Add debug flag if requested
    if (options.debug) {
      args.unshift('--debug');
    }
    
    // Add model flag
    const modelToUse = options.model || 'sonnet';
    args.unshift('--model', modelToUse);
    
    // Add print flag for non-interactive mode (equivalent to --prompt in Gemini)
    args.unshift('-p');
    
    // Add skip permissions flag
    if (settings.skipPermissions) {
      args.unshift('--yolo');
    }
    
    // Try to find codebuddy in PATH first, then fall back to environment variable
    const codebuddyPath = process.env.CODEBUDDY_PATH || 'codebuddy';
    
    const codebuddyProcess = spawn(codebuddyPath, args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    
    // Attach temp file info to process for cleanup later
    codebuddyProcess.tempImagePaths = tempImagePaths;
    codebuddyProcess.tempDir = tempDir;
    
    // Store process reference for potential abort
    const processKey = capturedSessionId || sessionId || Date.now().toString();
    activeCodeBuddyProcesses.set(processKey, codebuddyProcess);
    
    // Store sessionId on the process object for debugging
    codebuddyProcess.sessionId = processKey;
    
    // Close stdin to signal we're done sending input
    codebuddyProcess.stdin.end();
    
    // Add timeout handler
    let hasReceivedOutput = false;
    const timeoutMs = 30000; // 30 seconds
    const timeout = setTimeout(() => {
      if (!hasReceivedOutput) {
        ws.send(JSON.stringify({
          type: 'codebuddy-error',
          error: 'CodeBuddy CLI timeout - no response received'
        }));
        codebuddyProcess.kill('SIGTERM');
      }
    }, timeoutMs);
    
    // Save user message to session when starting
    if (command && capturedSessionId) {
      sessionManager.addMessage(capturedSessionId, 'user', command);
    }
    
    // Handle stdout (CodeBuddy outputs plain text)
    let outputBuffer = '';
    
    codebuddyProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      outputBuffer += rawOutput;
      hasReceivedOutput = true;
      clearTimeout(timeout);
      
      // Filter out debug messages and system messages
      const lines = rawOutput.split('\n');
      const filteredLines = lines.filter(line => {
        // Skip debug messages and system messages
        if (line.includes('[DEBUG]') ||
            line.includes('Flushing log events') ||
            line.includes('Clearcut response') ||
            line.includes('[MemoryDiscovery]') ||
            line.includes('[BfsFileSearch]')) {
          return false;
        }
        return true;
      });
      
      const filteredOutput = filteredLines.join('\n').trim();
      
      if (filteredOutput) {
        // Accumulate the full response
        fullResponse += (fullResponse ? '\n' : '') + filteredOutput;
        
        // Send the filtered output as a message
        ws.send(JSON.stringify({
          type: 'codebuddy-response',
          data: {
            type: 'message',
            content: filteredOutput
          }
        }));
      }
      
      // For new sessions, create a session ID
      if (!sessionId && !sessionCreatedSent && !capturedSessionId) {
        capturedSessionId = `codebuddy_${Date.now()}`;
        sessionCreatedSent = true;
        
        // Create session in session manager
        sessionManager.createSession(capturedSessionId, cwd || process.cwd());
        
        // Save the user message now that we have a session ID
        if (command) {
          sessionManager.addMessage(capturedSessionId, 'user', command);
        }
        
        // Update process key with captured session ID
        if (processKey !== capturedSessionId) {
          activeCodeBuddyProcesses.delete(processKey);
          activeCodeBuddyProcesses.set(capturedSessionId, codebuddyProcess);
        }
        
        ws.send(JSON.stringify({
          type: 'session-created',
          sessionId: capturedSessionId
        }));
      }
    });
    
    // Handle stderr
    codebuddyProcess.stderr.on('data', (data) => {
      const errorMsg = data.toString();
      
      // Filter out deprecation warnings
      if (errorMsg.includes('[DEP0040]') ||
          errorMsg.includes('DeprecationWarning') ||
          errorMsg.includes('--trace-deprecation')) {
        return;
      }
      
      ws.send(JSON.stringify({
        type: 'codebuddy-error',
        error: errorMsg
      }));
    });

    // Handle process completion
    codebuddyProcess.on('close', async (code) => {
      clearTimeout(timeout);
      
      // Clean up process reference
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeCodeBuddyProcesses.delete(finalSessionId);
      
      // Save assistant response to session if we have one
      if (finalSessionId && fullResponse) {
        sessionManager.addMessage(finalSessionId, 'assistant', fullResponse);
      }
      
      ws.send(JSON.stringify({
        type: 'codebuddy-complete',
        exitCode: code,
        isNewSession: !sessionId && !!command // Flag to indicate this was a new session
      }));
      
      // Clean up temporary image files if any
      if (codebuddyProcess.tempImagePaths && codebuddyProcess.tempImagePaths.length > 0) {
        for (const imagePath of codebuddyProcess.tempImagePaths) {
          await fs.unlink(imagePath).catch(err => {
            // Error handling for file deletion
          });
        }
        if (codebuddyProcess.tempDir) {
          await fs.rm(codebuddyProcess.tempDir, { recursive: true, force: true }).catch(err => {
            // Error handling for directory deletion
          });
        }
      }
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`CodeBuddy CLI exited with code ${code}`));
      }
    });
    
    // Handle process errors
    codebuddyProcess.on('error', (error) => {
      // Clean up process reference on error
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeCodeBuddyProcesses.delete(finalSessionId);
      
      ws.send(JSON.stringify({
        type: 'codebuddy-error',
        error: error.message
      }));
      
      reject(error);
    });
  });
}

function abortCodeBuddySession(sessionId) {
  // Try to find the process by session ID
  let process = activeCodeBuddyProcesses.get(sessionId);
  let processKey = sessionId;
  
  if (!process) {
    // Search for process with matching session ID in keys
    for (const [key, proc] of activeCodeBuddyProcesses.entries()) {
      if (key.includes(sessionId) || sessionId.includes(key)) {
        process = proc;
        processKey = key;
        break;
      }
    }
  }
  
  if (process) {
    try {
      // First try SIGTERM
      process.kill('SIGTERM');
      
      // Set a timeout to force kill if process doesn't exit
      setTimeout(() => {
        if (activeCodeBuddyProcesses.has(processKey)) {
          try {
            process.kill('SIGKILL');
          } catch (e) {
            // Error handling for force kill
          }
        }
      }, 2000); // Wait 2 seconds before force kill
      
      activeCodeBuddyProcesses.delete(processKey);
      return true;
    } catch (error) {
      activeCodeBuddyProcesses.delete(processKey);
      return false;
    }
  }
  
  return false;
}

async function getCodeBuddySpec(type, context) {
  return new Promise(async (resolve, reject) => {
    let fullResponse = '';
    const args = [];

    const prompt = `Generate a ${type} for a new feature. Here is the context:\n\n${context}`;
    args.push('-p', prompt);

    const codebuddyPath = process.env.CODEBUDDY_PATH || 'codebuddy';
    const codebuddyProcess = spawn(codebuddyPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    codebuddyProcess.stdin.end();

    codebuddyProcess.stdout.on('data', (data) => {
      fullResponse += data.toString();
    });

    codebuddyProcess.stderr.on('data', (data) => {
      console.error(`CodeBuddy CLI stderr: ${data}`);
    });

    codebuddyProcess.on('close', (code) => {
      if (code === 0) {
        resolve(fullResponse);
      } else {
        reject(new Error(`CodeBuddy CLI exited with code ${code}`));
      }
    });

    codebuddyProcess.on('error', (error) => {
      reject(error);
    });
  });
}

export {
  spawnCodeBuddy,
  abortCodeBuddySession,
  getCodeBuddySpec
};