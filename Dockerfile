# Use official Node.js base image
FROM node:20

# Create safe working directory
RUN mkdir /xylo && chmod -R 777 /xylo
WORKDIR /xylo

# Clone your GitHub repo
RUN git clone https://github.com/Mek-d1/XYLO-MD.git .

# Install dependencies
RUN npm install

# Environment variable defaults (can be overridden by Hugging Face UI)
ENV PORT=7860
ENV DEPLOYMENT=huggingface
ENV XYLO_MODE=ai

# Copy the start.sh script
COPY start.sh .

# Make script executable
RUN chmod +x start.sh

# Expose Hugging Face default port
EXPOSE 7860

# Run using bash script to avoid SIGTERM issues
CMD ["./start.sh"]